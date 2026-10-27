/**
 * The one module-scope edit whose observers can be named: a side-effect-free
 * initializer of a variable that only functions read.
 *
 * A hunk at module scope selects every load observer, because anything in the
 * process may have read what the module computed. That is far more than can see
 * the change when the edit is the initializer of a `const` that no code outside a
 * function body ever touches: only a test that ran one of the functions
 * referencing it can observe the new value. This module proves that case and
 * names the reference sites; anything it cannot prove answers with a reason and
 * the caller keeps today's rule.
 *
 * CBD reimplements no TypeScript semantics. Names are resolved by the project's
 * own checker (one file, `noResolve`, `noLib`), so a shadowing parameter or block
 * binding is told apart from the binding by symbol, never by spelling. An
 * identifier the checker cannot resolve counts as a reference to the binding.
 *
 * The proof, for the old and the new text alike. Every hunk lies on the lines of
 * one top-level variable statement and no other top-level statement shares them.
 * That statement declares one identifier, is not `export`ed or `declare`d, and the
 * file is an ES module (a script's top-level `var` is a global). The initializer
 * is side-effect free and cannot throw: literals, regular expressions, templates
 * whose substitutions are primitives, arrays and objects of those (no spread, no
 * methods or accessors, computed keys must be primitives), a few operators on
 * operand types they cannot throw on, and earlier top-level `const`s that satisfy
 * the same rule. Calls, `new`, member access, tagged templates, `await`, `yield`,
 * assignments, and function and class expressions are all refused. The binding
 * has one declaration and no reference outside a function body, which includes
 * `export { X }`, `export default X`, a class field initializer, a static block, a
 * decorator, a default parameter value and a computed key of a module-level class
 * or object. The file uses none of `eval`, `with` or `arguments`.
 */
import type { LineRange } from './changes.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ts = any

/** The binding(s) a module-scope hunk edits and where functions read them. */
export interface BindingRead {
  /** The edited bindings, sorted. */
  names: string[]
  /** 1-based lines, in the map's coordinates, of every reference to them. */
  lines: number[]
}

export type BindingVerdict = { ok: true; read: BindingRead } | { ok: false; why: string }

const fail = (why: string): BindingVerdict => ({ ok: false, why })

/** What a pure expression evaluates to, as far as operators care. */
type Kind = 'num' | 'str' | 'bool' | 'null' | 'bigint' | 'regex' | 'obj' | 'unknown'

interface Analysis {
  names: string[]
  lines: number[]
}

/**
 * Prove the case for one version of the file.
 *
 * `hunks` are the lines of THIS version that changed. Returns the edited bindings
 * and their reference sites in this version's coordinates.
 */
function analyze(
  ts: Ts,
  options: object,
  fileName: string,
  text: string,
  hunks: readonly LineRange[],
): Analysis | string {
  if (hunks.length === 0) return 'no hunks'
  // TypeScript breaks lines on a lone CR, U+2028 and U+2029; git and the map break on
  // LF only, so line numbers from the AST would not be the hunks' numbers.
  if (/\r(?!\n)|[\u2028\u2029]/.test(text)) return 'the file has line terminators git does not break on'
  const kind = /x$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const parsed = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)
  const host = ts.createCompilerHost(options, true)
  // TypeScript hands the host its own `/`-separated spelling of the root name, so a
  // Windows path compared as written would never match and the program would be empty.
  const isFile = (name: string): boolean => name.replaceAll('\\', '/') === fileName.replaceAll('\\', '/')
  host.getSourceFile = (name: string) => (isFile(name) ? parsed : undefined)
  host.fileExists = (name: string) => isFile(name)
  host.readFile = (name: string) => (isFile(name) ? text : undefined)
  host.directoryExists = () => false
  host.getDirectories = () => []
  const program = ts.createProgram({
    rootNames: [fileName],
    options: { ...options, noResolve: true, noLib: true, types: [], noEmit: true, incremental: false, composite: false },
    host,
  })
  const sf = program.getSourceFile(fileName)
  if (sf === undefined) return 'program did not load the file'
  const checker = program.getTypeChecker()

  // A script's top-level declarations are globals every file can see.
  if (!ts.isExternalModule(sf)) return 'the file is not an ES module'

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1
  const spanOf = (node: Ts): [number, number] => [lineOf(node.getStart(sf)), lineOf(node.end)]

  // eval / with / arguments make name resolution unprovable.
  let unprovable: string | undefined
  const scan = (node: Ts): void => {
    if (unprovable !== undefined) return
    if (ts.isWithStatement(node)) unprovable = 'the file uses with'
    else if (ts.isIdentifier(node) && (node.text === 'eval' || node.text === 'arguments')) {
      unprovable = `the file uses ${node.text as string}`
    }
    ts.forEachChild(node, scan)
  }
  scan(sf)
  if (unprovable !== undefined) return unprovable

  // The statements the hunks sit on.
  const chosen = new Set<Ts>()
  for (const hunk of hunks) {
    let holder: Ts
    for (const statement of sf.statements) {
      const [first, last] = spanOf(statement)
      if (last < hunk.start || first > hunk.end) continue
      if (holder !== undefined) return 'a hunk touches more than one module-scope statement'
      holder = statement
      if (first > hunk.start || last < hunk.end) {
        // Lines of the hunk outside the statement are comments, blanks or other code.
        return 'a hunk reaches past the statement it edits'
      }
    }
    if (holder === undefined) return 'a hunk is on no module-scope statement'
    chosen.add(holder)
  }
  // A hunk's lines must be wholly one statement's: nothing else may start or end on them.
  for (const statement of chosen) {
    const [first, last] = spanOf(statement)
    for (const other of sf.statements) {
      if (other === statement) continue
      const [from, to] = spanOf(other)
      if (to >= first && from <= last) return 'another statement shares the edited lines'
    }
  }

  const declarations: Ts[] = []
  for (const statement of chosen) {
    if (!ts.isVariableStatement(statement)) return 'the edit is not in a variable statement'
    const modifiers: readonly Ts[] = statement.modifiers ?? []
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DeclareKeyword)) {
      return 'the binding is exported or ambient'
    }
    const list = statement.declarationList
    if ((list.flags & ts.NodeFlags.Using) !== 0) return 'a using declaration'
    if (list.declarations.length !== 1) return 'a statement declaring several bindings'
    const declaration = list.declarations[0]
    if (!ts.isIdentifier(declaration.name)) return 'a destructuring declaration'
    if (declaration.initializer === undefined) return 'a declaration with no initializer'
    declarations.push(declaration)
  }

  // Purity of an initializer: evaluating it runs no code and cannot throw.
  const visiting = new Set<Ts>()
  const kindOf = (expr: Ts): Kind | undefined => {
    switch (expr.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return 'num'
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return 'str'
      case ts.SyntaxKind.BigIntLiteral:
        return 'bigint'
      case ts.SyntaxKind.RegularExpressionLiteral:
        return 'regex'
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
        return 'bool'
      case ts.SyntaxKind.NullKeyword:
        return 'null'
      default:
        break
    }
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) {
      return kindOf(expr.expression)
    }
    if (ts.isTemplateExpression(expr)) {
      for (const span of expr.templateSpans) {
        const inner = kindOf(span.expression)
        // A substitution of an object calls its toString.
        if (inner === undefined || inner === 'obj' || inner === 'regex' || inner === 'unknown') return undefined
      }
      return 'str'
    }
    if (ts.isArrayLiteralExpression(expr)) {
      for (const element of expr.elements) {
        if (ts.isOmittedExpression(element)) continue
        if (kindOf(element) === undefined) return undefined
      }
      return 'obj'
    }
    if (ts.isObjectLiteralExpression(expr)) {
      for (const property of expr.properties) {
        if (ts.isPropertyAssignment(property)) {
          if (ts.isComputedPropertyName(property.name)) {
            const key = kindOf(property.name.expression)
            if (key !== 'num' && key !== 'str' && key !== 'bool' && key !== 'null') return undefined
          }
          if (kindOf(property.initializer) === undefined) return undefined
        } else if (ts.isShorthandPropertyAssignment(property)) {
          if (identifierKind(property.name, property.name) === undefined) return undefined
        } else {
          return undefined
        }
      }
      return 'obj'
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      const operand = kindOf(expr.operand)
      if (operand === undefined) return undefined
      switch (expr.operator) {
        case ts.SyntaxKind.ExclamationToken:
          return 'bool'
        case ts.SyntaxKind.MinusToken:
        case ts.SyntaxKind.TildeToken:
          return operand === 'num' || operand === 'bigint' ? operand : undefined
        case ts.SyntaxKind.PlusToken:
          return operand === 'num' ? 'num' : undefined
        default:
          return undefined
      }
    }
    if (ts.isTypeOfExpression(expr)) return kindOf(expr.expression) === undefined ? undefined : 'str'
    if (ts.isVoidExpression(expr)) return kindOf(expr.expression) === undefined ? undefined : 'unknown'
    if (ts.isBinaryExpression(expr)) {
      const left = kindOf(expr.left)
      const right = kindOf(expr.right)
      if (left === undefined || right === undefined) return undefined
      const op = expr.operatorToken.kind
      const S = ts.SyntaxKind
      const primitive = (k: Kind): boolean => k === 'num' || k === 'str' || k === 'bool' || k === 'null'
      switch (op) {
        case S.AmpersandAmpersandToken:
        case S.BarBarToken:
        case S.QuestionQuestionToken:
          return left === right ? left : 'unknown'
        case S.EqualsEqualsEqualsToken:
        case S.ExclamationEqualsEqualsToken:
          return 'bool'
        case S.EqualsEqualsToken:
        case S.ExclamationEqualsToken:
          return primitive(left) && primitive(right) ? 'bool' : undefined
        case S.LessThanToken:
        case S.GreaterThanToken:
        case S.LessThanEqualsToken:
        case S.GreaterThanEqualsToken:
          return (left === 'num' && right === 'num') || (left === 'str' && right === 'str') ? 'bool' : undefined
        case S.PlusToken:
          if (left === 'num' && right === 'num') return 'num'
          if ((left === 'str' && primitive(right)) || (right === 'str' && primitive(left))) return 'str'
          return undefined
        case S.MinusToken:
        case S.AsteriskToken:
        case S.SlashToken:
        case S.PercentToken:
        case S.AsteriskAsteriskToken:
        case S.AmpersandToken:
        case S.BarToken:
        case S.CaretToken:
        case S.LessThanLessThanToken:
        case S.GreaterThanGreaterThanToken:
        case S.GreaterThanGreaterThanGreaterThanToken:
          return left === 'num' && right === 'num' ? 'num' : undefined
        default:
          return undefined
      }
    }
    if (ts.isIdentifier(expr)) return identifierKind(expr, expr)
    return undefined
  }

  /** An identifier of an earlier top-level `const` that is itself pure. */
  const identifierKind = (id: Ts, at: Ts): Kind | undefined => {
    const symbol =
      ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
        ? checker.getShorthandAssignmentValueSymbol(id.parent)
        : checker.getSymbolAtLocation(id)
    const declaration = symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined
    const list = declaration.parent
    const statement = list?.parent
    if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(statement)) return undefined
    if (statement.parent !== sf || (list.flags & ts.NodeFlags.Const) === 0) return undefined
    if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return undefined
    // A use before the declaration is a TDZ error; a cycle never finishes.
    if (declaration.end > at.getStart(sf) || visiting.has(declaration)) return undefined
    visiting.add(declaration)
    try {
      return kindOf(declaration.initializer)
    } finally {
      visiting.delete(declaration)
    }
  }

  for (const declaration of declarations) {
    visiting.add(declaration)
    const result = kindOf(declaration.initializer)
    visiting.delete(declaration)
    if (result === undefined) {
      return `the initializer of ${declaration.name.text as string} is not provably side-effect free`
    }
  }

  // References, by symbol.
  const lines = new Set<number>()
  for (const declaration of declarations) {
    const symbol = checker.getSymbolAtLocation(declaration.name)
    if (symbol === undefined || (symbol.declarations ?? []).length !== 1) {
      return `${declaration.name.text as string} is declared more than once or cannot be resolved`
    }
    const name: string = declaration.name.text
    let blocked: string | undefined
    const visit = (node: Ts): void => {
      if (blocked !== undefined) return
      if (ts.isIdentifier(node) && node.text === name && node !== declaration.name && !namesNoBinding(ts, node)) {
        if (ts.isExportSpecifier(node.parent) || ts.isExportAssignment(node.parent)) {
          blocked = `${name} is exported`
          return
        }
        const resolved = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node)
        // Unresolvable: assume it is this binding.
        if (resolved === undefined || resolved === symbol) {
          if (!insideFunctionBody(ts, node)) {
            blocked = `${name} is read at module scope`
            return
          }
          lines.add(lineOf(node.getStart(sf)))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (blocked !== undefined) return blocked
    // `export default X` has the identifier under ExportAssignment, handled above; a
    // re-export names the binding through an export specifier, also above.
  }

  return {
    names: declarations.map((d) => d.name.text as string).sort(),
    lines: [...lines].sort((a, b) => a - b),
  }
}

/** Is `node` the name of a property or member rather than a variable reference? */
function namesNoBinding(ts: Ts, node: Ts): boolean {
  const parent = node.parent
  if (parent === undefined) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isQualifiedName(parent) && parent.right === node) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true
  if (
    (ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true
  }
  return false
}

/**
 * Does `node` run only when a function is called? True when the nearest function
 * it sits in holds it in its body. A default parameter value, a decorator, a class
 * field initializer, a static block and a computed key of a module-level class run
 * with the module, so climbing past them reaches the file and answers no.
 */
function insideFunctionBody(ts: Ts, node: Ts): boolean {
  let child = node
  for (let parent = node.parent; parent !== undefined; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent) && parent.body !== undefined && parent.body === child) return true
  }
  return false
}

/**
 * Prove the case for the old and the new text, `bases` being every text the old
 * side must hold for (the range's base and the map's own commit).
 *
 * `hunks` are in `oldText`'s lines and `newHunks` in `head`'s. The proof is run on
 * each text on its own; the edited bindings must agree, and the reference sites
 * come from `oldText`, whose coordinates the map uses.
 */
export function proveBindingRead(
  ts: Ts,
  options: object,
  fileName: string,
  oldText: string,
  head: string,
  hunks: readonly LineRange[],
  newHunks: readonly LineRange[],
): BindingVerdict {
  try {
    const before = analyze(ts, options, fileName, oldText, hunks)
    if (typeof before === 'string') return fail(before)
    const after = analyze(ts, options, fileName, head, newHunks)
    if (typeof after === 'string') return fail(after)
    if (before.names.join('\u0000') !== after.names.join('\u0000')) return fail('the edited bindings differ')
    return { ok: true, read: { names: before.names, lines: before.lines } }
  } catch (error) {
    return fail(`binding analysis failed: ${String(error)}`)
  }
}
