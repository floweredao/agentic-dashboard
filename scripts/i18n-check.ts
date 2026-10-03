import ts from "typescript";

export interface Finding { readonly file: string; readonly line: number; readonly text: string }

const HANGUL = /[가-힣]/;
const ALLOW = /\/\/ i18n-allow: \S/;

function inKoreanDictionary(node: ts.Node): boolean {
  let inKo = false;
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && parent.name.text === "ko") inKo = true;
    if (inKo && ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "strings") return true;
  }
  return false;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join("…");
  return null;
}

/** Every Korean string, template or JSX text in `source` outside a `ko` dictionary entry; a line ending in `// i18n-allow: <reason>` keeps its Korean on purpose. */
export function findKoreanOutsideDictionaries(file: string, source: string): Finding[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    const text = literalText(node);
    if (text !== null && HANGUL.test(text) && !inKoreanDictionary(node)) {
      const line = root.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (!ALLOW.test(lines[line - 1] ?? "")) findings.push({ file, line, text: text.trim().slice(0, 80) });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return findings;
}

/** The UI source files: everything under src except tests and test helpers. */
export async function uiFiles(): Promise<string[]> {
  const files = await Array.fromAsync(new Bun.Glob("src/**/*.{ts,tsx}").scan());
  return files.filter(file => !/\.test\.tsx?$/.test(file) && !/(^|\/)test-[^/]*$/.test(file)).sort();
}

if (import.meta.main) {
  const files = Bun.argv.length > 2 ? Bun.argv.slice(2) : await uiFiles();
  const findings = (await Promise.all(files.map(async file => findKoreanOutsideDictionaries(file, await Bun.file(file).text())))).flat();
  for (const finding of findings) console.log(`${finding.file}:${finding.line}: ${finding.text}`);
  console.log(findings.length ? `${findings.length} Korean text(s) outside a ko dictionary.` : `No Korean text outside ko dictionaries in ${files.length} file(s).`);
  process.exitCode = findings.length ? 1 : 0;
}
