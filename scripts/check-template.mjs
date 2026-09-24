#!/usr/bin/env node
/**
 * Checks template.tpl without Google Tag Manager (there is no official CLI):
 *
 *   1. Structure: every section a Community Template Gallery tag template
 *      needs is present, and every JSON section parses.
 *   2. Fields: the site key is required (NON_EMPTY), and every `data.x` the
 *      code reads is a declared field.
 *   3. Permissions: every sandboxed API the code requires is covered by a
 *      declared permission, the injected URL is inside the inject_script
 *      allow-list, and the globals are exactly the ones install contract §10
 *      allows (read+write __deploysealConfig, read __deployseal).
 *   4. Sandbox hygiene: no regular expressions, no window/document access.
 *   5. Tests: runs every scenario in the ___TESTS___ section in Node against
 *      a small re-implementation of GTM's test API (runCode, mock, assertApi,
 *      assertThat), then checks the template's environment slug against the
 *      reference slugifyEnvironmentLabel on a wide set of inputs.
 *   6. metadata.yaml names a homepage, documentation and at least one
 *      version whose commit contains template.tpl (when git is available).
 *
 *   node scripts/check-template.mjs
 *
 * This is a lint and a behavioural check, not GTM: a real import into a
 * container and a Preview run remain the final word.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const failures = []
const fail = (msg) => failures.push(msg)
let checks = 0
const ok = (cond, msg) => {
  checks++
  if (!cond) fail(msg)
  return cond
}

// ── 1. Sections ─────────────────────────────────────────────────────────────

const tpl = readFileSync(root + 'template.tpl', 'utf8').replace(/\r\n/g, '\n')
const sections = {}
{
  const re = /^___([A-Z_]+)___$/gm
  const marks = [...tpl.matchAll(re)]
  marks.forEach((m, i) => {
    const start = m.index + m[0].length
    const end = i + 1 < marks.length ? marks[i + 1].index : tpl.length
    sections[m[1]] = tpl.slice(start, end).trim()
  })
}
const REQUIRED = [
  'TERMS_OF_SERVICE',
  'INFO',
  'TEMPLATE_PARAMETERS',
  'SANDBOXED_JS_FOR_WEB_TEMPLATE',
  'WEB_PERMISSIONS',
  'TESTS',
  'NOTES',
]
for (const name of REQUIRED) ok(name in sections, `missing section ___${name}___`)
ok(tpl.startsWith('___TERMS_OF_SERVICE___'), 'template.tpl must start with ___TERMS_OF_SERVICE___')

function json(name) {
  try {
    return JSON.parse(sections[name] ?? '')
  } catch (e) {
    fail(`___${name}___ is not valid JSON: ${e.message}`)
    return null
  }
}
const info = json('INFO')
const params = json('TEMPLATE_PARAMETERS')
const permissions = json('WEB_PERMISSIONS')
const code = sections.SANDBOXED_JS_FOR_WEB_TEMPLATE ?? ''

if (info) {
  ok(info.type === 'TAG', 'INFO.type must be TAG')
  ok(Array.isArray(info.containerContexts) && info.containerContexts.includes('WEB'), 'INFO.containerContexts must include WEB')
  ok(typeof info.displayName === 'string' && info.displayName.length > 0, 'INFO.displayName is required')
  ok(typeof info.description === 'string' && info.description.length > 0 && info.description.length <= 400, 'INFO.description is required (≤ 400 chars)')
  ok(info.brand && typeof info.brand.displayName === 'string', 'INFO.brand.displayName is required')
  ok(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(info.brand?.thumbnail ?? ''), 'INFO.brand.thumbnail must be a base64 PNG data URI')
  ok(info.id === 'cvt_temp_public_id', 'INFO.id must stay cvt_temp_public_id (the gallery assigns the real one)')
}

// ── 2. Fields ───────────────────────────────────────────────────────────────

const fields = new Map()
function collect(list) {
  for (const p of list ?? []) {
    if (p.name) {
      ok(!fields.has(p.name), `field name ${p.name} is declared twice`)
      fields.set(p.name, p)
    }
    if (p.subParams) collect(p.subParams)
  }
}
if (Array.isArray(params)) collect(params)
else fail('___TEMPLATE_PARAMETERS___ must be a JSON array')

const siteKey = fields.get('siteKey')
ok(siteKey, 'field siteKey is missing')
ok(siteKey?.valueValidators?.some((v) => v.type === 'NON_EMPTY'), 'siteKey must have a NON_EMPTY validator')
for (const name of ['environment', 'build', 'apiBase']) {
  const f = fields.get(name)
  ok(f, `field ${name} is missing`)
  ok(!f?.valueValidators?.some((v) => v.type === 'NON_EMPTY'), `field ${name} must stay optional`)
}
for (const [name, f] of fields) {
  if (f.type !== 'GROUP') ok(typeof f.help === 'string' && f.help.length > 0, `field ${name} needs help text`)
}
ok(fields.get('apiBase') && params.find((p) => p.type === 'GROUP')?.subParams?.some((p) => p.name === 'apiBase'), 'apiBase belongs in the Advanced group')

for (const m of code.matchAll(/\bdata\.([A-Za-z_$][\w$]*)/g)) {
  const name = m[1]
  if (name === 'gtmOnSuccess' || name === 'gtmOnFailure') continue
  ok(fields.has(name), `code reads data.${name}, which is not a declared field`)
}

// ── 3. Permissions ──────────────────────────────────────────────────────────

/** Sandboxed APIs that need a permission, and which one. */
const API_PERMISSION = {
  injectScript: 'inject_script',
  copyFromWindow: 'access_globals',
  setInWindow: 'access_globals',
  callInWindow: 'access_globals',
  aliasInWindow: 'access_globals',
  createQueue: 'access_globals',
  createArgumentsQueue: 'access_globals',
  logToConsole: 'logging',
  sendPixel: 'send_pixel',
  getCookieValues: 'get_cookies',
  setCookie: 'set_cookies',
  getUrl: 'get_url',
  getReferrerUrl: 'get_referrer',
  localStorage: 'access_local_storage',
  queryPermission: null,
}
/** Sandboxed APIs that need none. */
const NO_PERMISSION = new Set(['makeString', 'makeNumber', 'makeInteger', 'getType', 'getTimestampMillis', 'Math', 'JSON', 'Object', 'encodeUriComponent', 'decodeUriComponent'])

const declared = new Map()
if (Array.isArray(permissions)) {
  for (const p of permissions) {
    const id = p?.instance?.key?.publicId
    ok(typeof id === 'string', 'a permission has no publicId')
    declared.set(id, p.instance.param ?? [])
  }
} else fail('___WEB_PERMISSIONS___ must be a JSON array')

const required = [...code.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
ok(required.length > 0, 'the code requires no APIs')
for (const api of required) {
  if (NO_PERMISSION.has(api)) continue
  ok(api in API_PERMISSION, `unknown sandboxed API ${api} (add it to API_PERMISSION if it is real)`)
  const perm = API_PERMISSION[api]
  if (perm) ok(declared.has(perm), `${api} needs the ${perm} permission`)
}
const expectedPerms = new Set(required.map((a) => API_PERMISSION[a]).filter(Boolean))
for (const id of declared.keys()) ok(expectedPerms.has(id), `permission ${id} is declared but not used`)

/** A GTM list value → JS array; a map value → object. */
function value(v) {
  if (!v) return undefined
  switch (v.type) {
    case 1: return v.string
    case 2: return (v.listItem ?? []).map(value)
    case 3: return Object.fromEntries((v.mapKey ?? []).map((k, i) => [value(k), value(v.mapValue[i])]))
    case 8: return v.boolean
    default: return v
  }
}
const param = (id, key) => value((declared.get(id) ?? []).find((p) => p.key === key)?.value)

const urls = param('inject_script', 'urls') ?? []
ok(isDeepStrictEqual(urls, ['https://cdn.deployseal.com/']), `inject_script must allow exactly https://cdn.deployseal.com/ (got ${JSON.stringify(urls)})`)
const widgetUrl = code.match(/WIDGET_URL\s*=\s*'([^']+)'/)?.[1]
ok(widgetUrl === 'https://cdn.deployseal.com/ds-widget.js', 'WIDGET_URL must be https://cdn.deployseal.com/ds-widget.js')
ok(urls.some((u) => widgetUrl?.startsWith(u)), 'the injected URL is outside the inject_script allow-list')

const globals = Object.fromEntries((param('access_globals', 'keys') ?? []).map((k) => [k.key, k]))
ok(isDeepStrictEqual(Object.keys(globals).sort(), ['__deployseal', '__deploysealConfig']), `access_globals must name exactly __deploysealConfig and __deployseal (got ${Object.keys(globals)})`)
ok(globals.__deploysealConfig?.read === true && globals.__deploysealConfig?.write === true && globals.__deploysealConfig?.execute === false, '__deploysealConfig must be read+write, not execute')
ok(globals.__deployseal?.read === true && globals.__deployseal?.write === false && globals.__deployseal?.execute === false, '__deployseal must be read only')

for (const p of permissions ?? []) ok(p.isRequired === true, `permission ${p?.instance?.key?.publicId} must be isRequired`)

// ── 4. Sandbox hygiene ──────────────────────────────────────────────────────

const stripped = code.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/\/\/.*$/gm, '')
ok(!/\bRegExp\b/.test(stripped), 'sandboxed JS has no RegExp')
ok(!/[=(,:]\s*\/[^/*\s]/.test(stripped) && !/\.(replace|match|search|split)\(\s*\//.test(stripped), 'sandboxed JS has no regular-expression literals')
ok(!/\b(window|document|eval|globalThis|Function)\b/.test(stripped), 'sandboxed JS cannot touch window/document/eval/Function directly')
ok(!/=>/.test(stripped), 'keep to function expressions (arrow functions are not used in this template)')

// ── 5. Tests ────────────────────────────────────────────────────────────────

/** The ___TESTS___ section: `scenarios: [- name, code: |-]` and `setup: |-`. */
function parseTests(text) {
  const lines = text.split('\n')
  const scenarios = []
  let setup = ''
  let i = 0
  const block = (indent) => {
    const out = []
    while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith(' '.repeat(indent)))) {
      out.push(lines[i].slice(indent))
      i++
    }
    return out.join('\n').replace(/\s+$/, '')
  }
  while (i < lines.length) {
    const line = lines[i]
    let m
    if (line === 'scenarios:' || line.trim() === '') {
      i++
    } else if ((m = line.match(/^- name: (.+)$/))) {
      i++
      const scenario = { name: m[1].trim(), code: '' }
      if (lines[i] === '  code: |-') {
        i++
        scenario.code = block(4)
      }
      scenarios.push(scenario)
    } else if (line === 'setup: |-') {
      i++
      setup = block(2)
    } else {
      fail(`___TESTS___: cannot read line ${JSON.stringify(line)}`)
      i++
    }
  }
  return { scenarios, setup }
}

class AssertionFailure extends Error {}

function subject(actual) {
  const bad = (what) => { throw new AssertionFailure(`expected ${JSON.stringify(actual)} ${what}`) }
  return {
    isEqualTo: (e) => isDeepStrictEqual(actual, e) || bad(`to equal ${JSON.stringify(e)}`),
    isNotEqualTo: (e) => !isDeepStrictEqual(actual, e) || bad(`not to equal ${JSON.stringify(e)}`),
    isUndefined: () => actual === undefined || bad('to be undefined'),
    isDefined: () => actual !== undefined || bad('to be defined'),
    isTrue: () => actual === true || bad('to be true'),
    isFalse: () => actual === false || bad('to be false'),
  }
}

/** Runs one scenario: GTM prepends the setup to each scenario's code. */
function runScenario(setup, scenarioCode) {
  const calls = {}
  const mocks = {}
  const record = (name, args) => (calls[name] ??= []).push(args)
  const defaults = {
    makeString: (v) => String(v),
    copyFromWindow: () => undefined,
    setInWindow: () => true,
    injectScript: () => {},
  }
  const sandboxRequire = (name) => {
    if (!(name in defaults) && !(name in mocks)) throw new Error(`require('${name}') has no stand-in in check-template.mjs`)
    return (...args) => {
      record(name, args)
      return (mocks[name] ?? defaults[name])(...args)
    }
  }
  const compiled = new Function('require', 'data', code)
  const api = {
    mock: (name, fn) => { mocks[name] = fn },
    runCode: (data) => {
      const d = { ...data }
      d.gtmOnSuccess = () => record('gtmOnSuccess', [])
      d.gtmOnFailure = () => record('gtmOnFailure', [])
      return compiled(sandboxRequire, d)
    },
    assertApi: (name) => ({
      wasCalled: () => { if (!calls[name]?.length) throw new AssertionFailure(`${name} was not called`) },
      wasNotCalled: () => { if (calls[name]?.length) throw new AssertionFailure(`${name} was called ${calls[name].length} time(s)`) },
      wasCalledWith: (...expected) => {
        if (!(calls[name] ?? []).some((args) => isDeepStrictEqual(args.slice(0, expected.length), expected))) {
          throw new AssertionFailure(`${name} was not called with ${JSON.stringify(expected)} (calls: ${JSON.stringify(calls[name] ?? [])})`)
        }
      },
    }),
    assertThat: subject,
    fail: (msg) => { throw new AssertionFailure(msg ?? 'fail()') },
  }
  const names = Object.keys(api)
  new Function(...names, `${setup}\n${scenarioCode}`)(...names.map((n) => api[n]))
}

const { scenarios, setup } = parseTests(sections.TESTS ?? '')
ok(scenarios.length > 0, '___TESTS___ has no scenarios')
const coverage = [
  ['injects with the right config', /injects the loader/i],
  ['environment slug', /slugif/i],
  ['empty site key', /empty site key/i],
  ['already installed', /already installed/i],
]
for (const [what, re] of coverage) ok(scenarios.some((s) => re.test(s.name)), `no scenario covers: ${what}`)
for (const s of scenarios) {
  checks++
  try {
    runScenario(setup, s.code)
    console.log(`  ok  ${s.name}`)
  } catch (e) {
    fail(`scenario "${s.name}": ${e.message}`)
    console.log(`  FAIL ${s.name}`)
  }
}

// The reference rule: slugifyEnvironmentLabel in the DeploySeal repository,
// packages/shared/src/install-contract.ts (install contract §2). Kept verbatim.
function slugifyEnvironmentLabel(name) {
  if (!name) return ''
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '')
}
{
  const inputs = [
    'Staging', 'UAT 2', '  Pre-Prod (EU) ', 'Ünïcode Ärger', '---', 'a_b.c/d', 'x', '9',
    'a'.repeat(31) + ' tail', 'b'.repeat(40), '-'.repeat(40) + 'z', 'a-'.repeat(20), 'ÀÉÎõü',
    'İstanbul', 'straße', 'ﬁle', 'staging uat', 'QA\tone', 'a' + ' '.repeat(40) + 'b',
  ]
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const alphabet = 'abcXYZ019 -_./()ÄéİßK '
  for (let n = 0; n < 500; n++) {
    let s = ''
    const len = Math.floor(rand() * 45)
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)]
    inputs.push(s)
  }
  let mismatches = 0
  for (const input of inputs) {
    let stored
    const compiled = new Function('require', 'data', code)
    const req = (name) => ({
      makeString: (v) => String(v),
      copyFromWindow: () => undefined,
      setInWindow: (k, v) => { stored = v; return true },
      injectScript: () => {},
    })[name]
    compiled(req, { siteKey: 'ls_key', environment: input, gtmOnSuccess() {}, gtmOnFailure() {} })
    const got = stored.dsEnvironment ?? ''
    const want = slugifyEnvironmentLabel(input)
    checks++
    if (got !== want) {
      mismatches++
      if (mismatches <= 5) fail(`slug of ${JSON.stringify(input)}: template ${JSON.stringify(got)}, contract ${JSON.stringify(want)}`)
    }
  }
  console.log(`  ok  environment slug matches slugifyEnvironmentLabel on ${inputs.length} inputs` + (mismatches ? ` (${mismatches} mismatches)` : ''))
}

// ── 6. metadata.yaml ────────────────────────────────────────────────────────

if (ok(existsSync(root + 'metadata.yaml'), 'metadata.yaml is missing')) {
  const meta = readFileSync(root + 'metadata.yaml', 'utf8').replace(/\r\n/g, '\n')
  ok(/^homepage: "?https:\/\/\S+"?$/m.test(meta), 'metadata.yaml needs a homepage URL')
  ok(/^documentation: "?https:\/\/\S+"?$/m.test(meta), 'metadata.yaml needs a documentation URL')
  ok(/^versions:$/m.test(meta), 'metadata.yaml needs versions')
  const shas = [...meta.matchAll(/^\s+- sha: ([0-9a-f]{40})$/gm)].map((m) => m[1])
  const notes = [...meta.matchAll(/^\s+changeNotes: .+$/gm)]
  ok(shas.length > 0 && shas.length === notes.length, 'every metadata.yaml version needs a 40-char sha and changeNotes')
  let git = false
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' })
    git = true
  } catch {}
  if (git) {
    for (const sha of shas) {
      try {
        execFileSync('git', ['cat-file', '-e', `${sha}:template.tpl`], { cwd: root, stdio: 'ignore' })
        checks++
      } catch {
        fail(`metadata.yaml version ${sha} is not a commit containing template.tpl (a shallow clone? fetch-depth: 0)`)
      }
    }
  }
}

ok(existsSync(root + 'LICENSE') && /Apache License\s+Version 2\.0/.test(readFileSync(root + 'LICENSE', 'utf8')), 'LICENSE must be Apache-2.0')

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\ntemplate.tpl: ${checks} checks passed`)
