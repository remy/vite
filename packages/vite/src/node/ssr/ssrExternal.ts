import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { InternalResolveOptions } from '../plugins/resolve'
import { tryNodeResolve } from '../plugins/resolve'
import {
  bareImportRE,
  createDebugger,
  createFilter,
  isBuiltin,
  isDefined,
  lookupFile,
  normalizePath,
  resolveFrom
} from '../utils'
import type { Logger, ResolvedConfig } from '..'

const debug = createDebugger('vite:ssr-external')

/**
 * Converts "parent > child" syntax to just "child"
 */
export function stripNesting(packages: string[]): string[] {
  return packages.map((s) => {
    const arr = s.split('>')
    return arr[arr.length - 1].trim()
  })
}

/**
 * Heuristics for determining whether a dependency should be externalized for
 * server-side rendering.
 */
export function cjsSsrResolveExternals(
  config: ResolvedConfig,
  knownImports: string[]
): string[] {
  // strip nesting since knownImports may be passed in from optimizeDeps which
  // supports a "parent > child" syntax
  knownImports = stripNesting(knownImports)

  const ssrConfig = config.ssr
  if (ssrConfig?.noExternal === true) {
    return []
  }

  const ssrExternals: Set<string> = new Set()
  const seen: Set<string> = new Set()
  ssrConfig?.external?.forEach((id) => {
    ssrExternals.add(id)
    seen.add(id)
  })

  cjsSsrCollectExternals(
    config.root,
    config.resolve.preserveSymlinks,
    ssrExternals,
    seen,
    config.logger
  )

  const importedDeps = knownImports.map(getNpmPackageName).filter(isDefined)
  for (const dep of importedDeps) {
    // Assume external if not yet seen
    // At this point, the project root and any linked packages have had their dependencies checked,
    // so we can safely mark any knownImports not yet seen as external. They are guaranteed to be
    // dependencies of packages in node_modules.
    if (!seen.has(dep)) {
      ssrExternals.add(dep)
    }
  }

  // ensure `vite/dynamic-import-polyfill` is bundled (issue #1865)
  ssrExternals.delete('vite')

  let externals = [...ssrExternals]
  if (ssrConfig?.noExternal) {
    externals = externals.filter(
      createFilter(undefined, ssrConfig.noExternal, { resolve: false })
    )
  }
  return externals
}

const CJS_CONTENT_RE =
  /\bmodule\.exports\b|\bexports[.\[]|\brequire\s*\(|\bObject\.(defineProperty|defineProperties|assign)\s*\(\s*exports\b/

// TODO: use import()
const _require = createRequire(import.meta.url)

const isSsrExternalCache = new WeakMap<
  ResolvedConfig,
  (id: string) => boolean | undefined
>()

export function shouldExternalizeForSSR(
  id: string,
  config: ResolvedConfig
): boolean | undefined {
  let isSsrExternal = isSsrExternalCache.get(config)
  if (!isSsrExternal) {
    isSsrExternal = createIsSsrExternal(config)
    isSsrExternalCache.set(config, isSsrExternal)
  }
  return isSsrExternal(id)
}

export function createIsConfiguredAsSsrExternal(
  config: ResolvedConfig
): (id: string) => boolean | undefined {
  const { ssr } = config
  const noExternal = ssr?.noExternal
  const noExternalFilter =
    noExternal !== 'undefined' &&
    typeof noExternal !== 'boolean' &&
    createFilter(undefined, noExternal, { resolve: false })

  // Returns true if it is configured as external, false if it is filtered
  // by noExternal and undefined if it isn't affected by the explicit config
  return (id: string) => {
    const { ssr } = config
    if (ssr) {
      const pkgName = getNpmPackageName(id)
      if (!pkgName) {
        return undefined
      }
      if (
        // If this id is defined as external, force it as external
        // Note that individual package entries are allowed in ssr.external
        ssr.external?.includes(id)
      ) {
        return true
      }
      if (
        // A package name in ssr.external externalizes every entry
        ssr.external?.includes(pkgName)
      ) {
        // Return undefined here to avoid short-circuiting the isExternalizable check,
        // that will filter this id out if it is not externalizable (e.g. a CSS file)
        // We return here to make ssr.external take precedence over noExternal
        return undefined
      }
      if (typeof noExternal === 'boolean') {
        return !noExternal
      }
      if (noExternalFilter && !noExternalFilter(pkgName)) {
        return false
      }
    }
    return undefined
  }
}

function createIsSsrExternal(
  config: ResolvedConfig
): (id: string) => boolean | undefined {
  const processedIds = new Map<string, boolean | undefined>()

  const { ssr, root } = config

  const isConfiguredAsExternal = createIsConfiguredAsSsrExternal(config)

  const resolveOptions: InternalResolveOptions = {
    root,
    preserveSymlinks: config.resolve.preserveSymlinks,
    isProduction: false,
    isBuild: true
  }

  const isExternalizable = (id: string) => {
    if (!bareImportRE.test(id) || id.includes('\0')) {
      return false
    }
    return !!tryNodeResolve(
      id,
      undefined,
      resolveOptions,
      ssr?.target === 'webworker',
      undefined,
      true,
      true // try to externalize, will return undefined if not possible
    )
  }

  return (id: string) => {
    if (processedIds.has(id)) {
      return processedIds.get(id)
    }
    let external = false
    if (!id.startsWith('.') && !path.isAbsolute(id)) {
      external =
        isBuiltin(id) || (isConfiguredAsExternal(id) ?? isExternalizable(id))
    }
    processedIds.set(id, external)
    return external
  }
}

// When config.experimental.buildSsrCjsExternalHeuristics is enabled, this function
// is used reverting to the Vite 2.9 SSR externalization heuristics
function cjsSsrCollectExternals(
  root: string,
  preserveSymlinks: boolean | undefined,
  ssrExternals: Set<string>,
  seen: Set<string>,
  logger: Logger
) {
  const rootPkgContent = lookupFile(root, ['package.json'])
  if (!rootPkgContent) {
    return
  }

  const rootPkg = JSON.parse(rootPkgContent)
  const deps = {
    ...rootPkg.devDependencies,
    ...rootPkg.dependencies
  }

  const resolveOptions: InternalResolveOptions = {
    root,
    preserveSymlinks,
    isProduction: false,
    isBuild: true
  }

  const depsToTrace = new Set<string>()

  for (const id in deps) {
    if (seen.has(id)) continue
    seen.add(id)

    let esmEntry: string | undefined
    let requireEntry: string

    try {
      esmEntry = tryNodeResolve(
        id,
        undefined,
        resolveOptions,
        true, // we set `targetWeb` to `true` to get the ESM entry
        undefined,
        true
      )?.id
      // normalizePath required for windows. tryNodeResolve uses normalizePath
      // which returns with '/', require.resolve returns with '\\'
      requireEntry = normalizePath(_require.resolve(id, { paths: [root] }))
    } catch (e) {
      try {
        // no main entry, but deep imports may be allowed
        const pkgPath = resolveFrom(`${id}/package.json`, root)
        if (pkgPath.includes('node_modules')) {
          ssrExternals.add(id)
        } else {
          depsToTrace.add(path.dirname(pkgPath))
        }
        continue
      } catch {}

      // resolve failed, assume include
      debug(`Failed to resolve entries for package "${id}"\n`, e)
      continue
    }
    // no esm entry but has require entry
    if (!esmEntry) {
      ssrExternals.add(id)
    }
    // trace the dependencies of linked packages
    else if (!esmEntry.includes('node_modules')) {
      const pkgPath = resolveFrom(`${id}/package.json`, root)
      depsToTrace.add(path.dirname(pkgPath))
    }
    // has separate esm/require entry, assume require entry is cjs
    else if (esmEntry !== requireEntry) {
      ssrExternals.add(id)
    }
    // if we're externalizing ESM and CJS should basically just always do it?
    // or are there others like SystemJS / AMD that we'd need to handle?
    // for now, we'll just leave this as is
    else if (/\.m?js$/.test(esmEntry)) {
      const pkgPath = resolveFrom(`${id}/package.json`, root)
      const pkgContent = fs.readFileSync(pkgPath, 'utf-8')

      if (!pkgContent) {
        continue
      }
      const pkg = JSON.parse(pkgContent)

      if (pkg.type === 'module' || esmEntry.endsWith('.mjs')) {
        ssrExternals.add(id)
        continue
      }
      // check if the entry is cjs
      const content = fs.readFileSync(esmEntry, 'utf-8')
      if (CJS_CONTENT_RE.test(content)) {
        ssrExternals.add(id)
        continue
      }

      logger.warn(
        `${id} doesn't appear to be written in CJS, but also doesn't appear to be a valid ES module (i.e. it doesn't have "type": "module" or an .mjs extension for the entry point). Please contact the package author to fix.`
      )
    }
  }

  for (const depRoot of depsToTrace) {
    cjsSsrCollectExternals(
      depRoot,
      preserveSymlinks,
      ssrExternals,
      seen,
      logger
    )
  }
}

export function cjsShouldExternalizeForSSR(
  id: string,
  externals: string[] | null
): boolean {
  if (!externals) {
    return false
  }
  const should = externals.some((e) => {
    if (id === e) {
      return true
    }
    // deep imports, check ext before externalizing - only externalize
    // extension-less imports and explicit .js imports
    if (id.startsWith(e + '/') && (!path.extname(id) || id.endsWith('.js'))) {
      return true
    }
  })
  return should
}

function getNpmPackageName(importPath: string): string | null {
  const parts = importPath.split('/')
  if (parts[0].startsWith('@')) {
    if (!parts[1]) return null
    return `${parts[0]}/${parts[1]}`
  } else {
    return parts[0]
  }
}
