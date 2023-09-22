import { dirname, resolve, extname } from 'path';
import module from 'module';
import pm from 'picomatch';
import { ImportKind, Loader, Plugin } from 'esbuild';
import { fs, isString } from '@modern-js/utils';
import { createFilter } from '@rollup/pluginutils';
import { normalizeSourceMap, resolvePathAndQuery } from '../../utils';
import { loaderMap } from '../../constants/loader';
import { debugResolve } from '../../debug';
import type { SideEffects, ICompiler } from '../../types';
import { writeFile } from './write-file';
import { initWatcher } from './watch';

/**
 * esbuld's external will keep import statement as import|require statement, which
 * is ok for node environment but will cause problem for browser environment(lack of commonjs runtime supports)
 * so we need to support features like rollup's globals, which will convert an module id to global variable
 * @example
 * {
 *   externals: {
 *   'jquery': '$'
 *   }
 * }
 * which will convert this code
 * import jq from 'jquery'
 * to
 * const jq = globalThis['$']
 */
const globalNamespace = 'globals';

const HTTP_PATTERNS = /^(https?:)?\/\//;
const DATAURL_PATTERNS = /^data:/;
const HASH_PATTERNS = /#[^#]+$/;
const DATAURL_JAVASCRIPT_PATTERNS = /^data:text\/javascript/;

export const adapterPlugin = (compiler: ICompiler): Plugin => {
  const { context } = compiler;
  const { config, root } = context;

  return {
    name: 'esbuild:adapter',
    setup(build) {
      build.onStart(() => {
        context.watch && initWatcher(compiler);
      });

      build.onResolve({ filter: /.*/ }, async args => {
        if (args.kind === 'url-token') {
          return {
            path: args.path,
            external: true,
          };
        }

        for (const [key] of Object.entries(config.umdGlobals)) {
          const isMatch = pm(key);
          if (isMatch(args.path)) {
            debugResolve('resolve umdGlobals:', key);
            return {
              path: args.path,
              namespace: globalNamespace,
            };
          }
        }

        /**
         * The node: protocol was added to require in Node v14.18.0
         * https://nodejs.org/api/esm.html#node-imports
         */
        if (/^node:/.test(args.path)) {
          return {
            path: args.path.slice(5),
            external: true,
          };
        }

        // esbuild cant handle return non absolute path from plugin, so we need to do a trick to handle this
        // see https://github.com/evanw/esbuild/issues/2404
        if (DATAURL_JAVASCRIPT_PATTERNS.test(args.path)) {
          return {
            path: args.path,
            namespace: 'dataurl',
          };
        }

        // external url
        const isUrl = (source: string) =>
          HTTP_PATTERNS.test(source) ||
          DATAURL_PATTERNS.test(source) ||
          HASH_PATTERNS.test(source);
        if (isUrl(args.path)) {
          return {
            path: args.path,
            external: true,
          };
        }

        const { externals, sideEffects: userSideEffects } = config;
        const regExternal = externals.filter(
          (item): item is RegExp => !isString(item),
        );
        const externalList = externals
          .filter(isString)
          .concat(config.platform === 'node' ? module.builtinModules : []);
        const externalMap = externalList.reduce((map, item) => {
          map.set(item, true);
          return map;
        }, new Map<string, boolean>());

        const getIsExternal = (name: string) => {
          if (externalMap.get(name)) {
            return true;
          }

          if (regExternal.some(reg => reg.test(name))) {
            return true;
          }

          return false;
        };

        /**
         * return module sideEffects
         * @param filePath
         * @param isExternal
         * @returns
         */
        const getSideEffects = async (
          filePath: string,
          isExternal: boolean,
        ) => {
          let pkgPath = '';
          let sideEffects: SideEffects | undefined | string[] = userSideEffects;
          let moduleSideEffects = true;

          if (typeof userSideEffects === 'undefined') {
            let curDir = dirname(filePath);
            try {
              while (curDir !== dirname(curDir)) {
                if (fs.existsSync(resolve(curDir, 'package.json'))) {
                  pkgPath = resolve(curDir, 'package.json');
                  break;
                }
                curDir = dirname(curDir);
              }
              // eslint-disable-next-line prefer-destructuring
              sideEffects = JSON.parse(
                fs.readFileSync(pkgPath, 'utf-8'),
              ).sideEffects;
            } catch (err) {
              // just ignore in case some system permission exception happens
            }
            if (!pkgPath) {
              return undefined;
            }
          }
          if (typeof sideEffects === 'boolean') {
            moduleSideEffects = sideEffects;
          } else if (Array.isArray(sideEffects)) {
            moduleSideEffects = createFilter(
              sideEffects.map(glob => {
                if (typeof glob === 'string') {
                  if (!glob.includes('/')) {
                    return `**/${glob}`;
                  }
                }
                return glob;
              }),
              null,
              pkgPath
                ? {
                    resolve: dirname(pkgPath),
                  }
                : undefined,
            )(filePath);
          } else if (typeof sideEffects === 'function') {
            moduleSideEffects = sideEffects(filePath, isExternal);
          }
          return moduleSideEffects;
        };

        const getResultPath = (id: string, dir: string, kind: ImportKind) => {
          return id.endsWith('.css')
            ? compiler.css_resolve(id, dir)
            : compiler.node_resolve(id, dir, kind);
        };

        const { originalFilePath, rawQuery } = resolvePathAndQuery(args.path);
        const suffix = (rawQuery ?? '').length > 0 ? `?${rawQuery}` : '';
        const isExternal = getIsExternal(originalFilePath);
        const dir =
          args.resolveDir ?? (args.importer ? dirname(args.importer) : root);
        const sideEffects = await getSideEffects(originalFilePath, isExternal);
        const result = {
          path: isExternal
            ? args.path
            : getResultPath(originalFilePath, dir, args.kind),
          external: isExternal,
          namespace: isExternal ? undefined : 'file',
          sideEffects,
          suffix,
        };
        debugResolve('onResolve args:', args);
        debugResolve('onResolve result:', result);
        return result;
      });
      build.onLoad({ filter: /.*/ }, async args => {
        if (args.namespace === globalNamespace) {
          const value = config.umdGlobals[args.path];
          return {
            contents: `module.exports = (typeof globalThis !== "undefined" ? globalThis : Function('return this')() || global || self)[${JSON.stringify(
              value,
            )}]`,
          };
        }

        if (args.suffix) {
          args.path += args.suffix;
        }

        if (args.namespace !== 'file') {
          return;
        }

        compiler.addWatchFile(args.path);
        let result = await compiler.hooks.load.promise(args);
        if (!result) {
          // let esbuild to handle data:text/javascript
          if (DATAURL_JAVASCRIPT_PATTERNS.test(args.path)) {
            return;
          }
          result = {
            contents: await fs.promises.readFile(args.path),
          };
        }

        // file don't need transform when loader is copy
        if (!result.contents || result.loader === 'copy') {
          return result;
        }

        const context = compiler.getTransformContext(args.path);

        context.addSourceMap(context.genPluginId('adapter'), result.map);

        const transformResult = await compiler.hooks.transform.promise({
          code: result.contents.toString(),
          path: args.path,
          loader: result.loader,
        });

        const ext = extname(args.path);

        const loader = (transformResult.loader ?? loaderMap[ext]) as Loader;

        const inlineSourceMap = context.getInlineSourceMap();

        return {
          contents: transformResult.code + inlineSourceMap,
          loader,
          resolveDir: result.resolveDir ?? dirname(args.path),
        };
      });

      build.onEnd(async result => {
        if (result.errors.length) {
          return;
        }
        const { outputs } = result.metafile!;
        const needSourceMap = Boolean(config.sourceMap);
        for (const [key, value] of Object.entries(outputs)) {
          if (key.endsWith('.map')) {
            continue;
          }
          const absPath = resolve(root, key);
          const item = result.outputFiles?.find(x => x.path === absPath);
          const mapping = result.outputFiles?.find(
            x =>
              x.path.endsWith('.map') &&
              x.path.replace(/\.map$/, '') === absPath,
          );
          if (!item) {
            continue;
          }
          if (absPath.endsWith('.js')) {
            compiler.emitAsset(absPath, {
              type: 'chunk',
              contents: item.text,
              map: normalizeSourceMap(mapping?.text, { needSourceMap }),
              fileName: absPath,
              entryPoint: value?.entryPoint,
            });
          } else {
            compiler.emitAsset(absPath, {
              type: 'asset',
              contents: Buffer.from(item.contents),
              fileName: absPath,
              entryPoint: value?.entryPoint,
            });
          }
        }

        for (const [key, value] of compiler.outputChunk.entries()) {
          const context = compiler.getSourcemapContext(value.fileName);
          if (value.type === 'chunk' && config.sourceMap) {
            context.addSourceMap(context.genPluginId('adapter'), value.map);
          }
          const processedResult = await compiler.hooks.renderChunk.promise(
            value,
          );
          if (processedResult.type === 'chunk' && config.sourceMap) {
            processedResult.map = context.getSourceMap();
          }
          compiler.outputChunk.set(key, processedResult);
        }

        if (config.metafile) {
          const now = Date.now();
          compiler.emitAsset(
            resolve(config.outDir, `metafile-${now}.json`),
            JSON.stringify(result.metafile!, null, 2),
          );
        }

        await writeFile(compiler);
      });
    },
  };
};