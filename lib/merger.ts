import { exec } from 'child_process';
import Debug from 'debug';
import path from 'path';
import fs from 'fs'
import { ExportsAnalyzerResult } from './exportsAnalyzer';
import { FileAnalyzer, FileAnalyzerResult } from './fileAnalyzer';
import { ImportsRegistry } from './importRegistry';
import { ImportsAnalyzer, ImportsAnalyzerResult } from './importsAnalyzer';
import { ExportType, ExportPluginCtor } from './types';
import { Utils } from './utils';
import { ExportPluginsRegistry } from './pluginsRegistry';

const error = Debug('sol-merger:error');
const debug = Debug('sol-merger:debug');

export class Merger {
  delimeter: string = this.options.delimeter || '\n\n';
  commentsDelimeter: string = this.options.commentsDelimeter || '\n';
  removeComments: boolean;

  private importRegistry: ImportsRegistry;
  #pluginsRegistry: ExportPluginsRegistry;
  nodeModulesRoot = '';

  constructor(private options: SolMergerOptions = {}) {
    if ('removeComments' in options) {
      this.removeComments = options.removeComments as boolean;
    } else {
      this.removeComments = false;
    }

    this.importRegistry = new ImportsRegistry();

    const exportPlugins = options.exportPlugins || [];
    this.#pluginsRegistry = new ExportPluginsRegistry(exportPlugins);
  }

  getPragmaRegex() {
    return /(pragma ([a-zA-Z_$][a-zA-Z_$0-9]*) (.+?);)/g;
  }

  getImportRegex() {
    return /import.+?;/g;
  }

  getPragma(contents: string) {
    let result = '';
    const pragmaRegex = this.getPragmaRegex();
    let group = pragmaRegex.exec(contents);
    while (group) {
      result += group[1] + '\n';
      group = pragmaRegex.exec(contents);
    }
    return result;
  }

  stripPragma(contents: string) {
    return contents.replace(this.getPragmaRegex(), '').trim();
  }

  async init(file: string) {
    this.importRegistry = new ImportsRegistry();
    this.nodeModulesRoot = await this.getNodeModulesPath(file);
  }

  async processFile(
    file: string,
    isRoot: boolean,
    parentImport?: ImportsAnalyzerResult,
  ): Promise<string> {
    if (isRoot) {
      await this.init(file);
    }
    if (this.importRegistry.isImportProcessed(parentImport?.importStatement)) {
      debug(
        '  %s Import statement already processed: %s',
        '⚠',
        parentImport?.importStatement,
      );
      return '';
    }
    if (parentImport) {
      this.importRegistry.registerImportStatement(parentImport.importStatement);
    }

    debug('Processing file %s', file);

    const analyzedFile = await new FileAnalyzer(
      file,
      this.removeComments,
    ).analyze();

    return this.buildString(analyzedFile, isRoot, parentImport);
  }

  private async buildString(
    analyzedFile: FileAnalyzerResult,
    isRoot: boolean,
    parentImport?: ImportsAnalyzerResult,
  ) {
    let result = '';

    if (isRoot) {
      const pragma = this.getPragma(analyzedFile.contents);
      result = pragma + this.delimeter;
    }

    const imports = await this.processImports(analyzedFile);

    for (const i of imports) {
      result += i + this.delimeter;
    }

    const fileExports = await this.processExports(analyzedFile, parentImport);
    for (const e of fileExports) {
      if (this.isComment(e)) {
        result += e + this.commentsDelimeter;
      } else {
        result += e + this.delimeter;
      }
    }

    return result.trimRight();
  }

  async processImports(analyzedFile: FileAnalyzerResult): Promise<string[]> {
    const result: string[] = [];
    for (const i of analyzedFile.imports) {
      let filePath = "";
      if (Utils.isRelative(i.file)) {
        filePath = path.join(path.dirname(analyzedFile.filename), i.file)
      } else {
        // right now /importsolfile can have following two possible places:
        // 1. <PWD>/importsolfile          (etherscan)
        // 2. <NPM ROOT>/importsolfile     (npm project)
        // let us try cwd first, and then try node_modules
        filePath = path.join(process.cwd(), i.file)
        if(!fs.existsSync(filePath)){
          filePath = path.join(this.nodeModulesRoot, i.file);
        }
      }
      filePath = path.normalize(filePath);

      const contents = await this.processFile(filePath!, false, i);

      if (contents) {
        result.push(contents);
      }
    }
    return result;
  }

  async processExports(
    analyzedFile: FileAnalyzerResult,
    parentImport?: ImportsAnalyzerResult,
  ): Promise<string[]> {
    const result: string[] = [];

    analyzedFile.exports.forEach((e) => {
      const fileExports = this.processExport(analyzedFile, e, parentImport);

      result.push(...fileExports);
    });
    return result;
  }

  private processExport(
    analyzedFile: FileAnalyzerResult,
    e: ExportsAnalyzerResult,
    parentImport?: ImportsAnalyzerResult,
  ): string[] {
    const isAllImport = ImportsAnalyzer.isAllImport(parentImport);

    const isRenameGlobalImport = ImportsAnalyzer.isRenameGlobalImport(
      parentImport,
    );

    const shouldBeImported = (exportName: string) => {
      if (
        e.type === ExportType.comment &&
        (isAllImport || isRenameGlobalImport)
      ) {
        return true;
      }
      return (
        isAllImport ||
        isRenameGlobalImport ||
        parentImport?.namedImports?.find(
          (namedImport) => namedImport.name === exportName,
        )
      );
    };

    const result: string[] = [];
    const beImported = shouldBeImported(e.name);
    let rename =
      typeof beImported === 'object' && beImported !== null
        ? beImported.as
        : null;
    const isImported = this.importRegistry.isImported(
      analyzedFile.filename,
      e.name,
      rename,
    );
    if (isImported) {
      debug('%s Already imported: %s %s', '⚠', e.name, analyzedFile.filename);
      return [];
    }
    if (beImported) {
      if (isRenameGlobalImport && parentImport) {
        rename = `${parentImport.globalRenameImport}$${e.name}`;
      }
      const globalRenames = this.importRegistry.getGlobalImports();
      const newExport = this.#pluginsRegistry.processExport(e);
      if (!newExport) {
        return [];
      }
      const body = FileAnalyzer.buildExportBody(
        analyzedFile,
        newExport,
        rename,
        globalRenames,
      );
      result.push(body);
      this.importRegistry.registerImport({
        as: rename,
        file: analyzedFile.filename,
        name: e.name,
        globalRename: parentImport && parentImport.globalRenameImport,
      });
    }
    return result;
  }

  stripImports(contents: string): string {
    return contents.replace(this.getImportRegex(), '').trim();
  }

  async getNodeModulesPath(file: string): Promise<string> {
    return Utils.getNodeModulesPath(file);
  }

  private isComment(str: string) {
    return str.startsWith('//') || str.startsWith('/*');
  }
}

export interface SolMergerOptions {
  delimeter?: string;
  removeComments?: boolean;
  commentsDelimeter?: string;
  exportPlugins?: ExportPluginCtor[];
}
