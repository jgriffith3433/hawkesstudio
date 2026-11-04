// unity-check <dir> --changed <file>... [--also <file>...]
// Parses the changed .cs files with Roslyn (syntax errors, CS1010 / CS1003 and the rest) and compiles them together
// with the other parts of their partial classes (--also) for the declaration errors CS0102 / CS0111. Missing Unity
// types are not this tool's business: only syntax errors and the duplicate-member codes are reported.
// Output: one JSON object per line {file,line,col,code,message}. Exit 0 = clean, 1 = errors found, 2 = bad usage.
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

if (args.Length < 2) { Console.Error.WriteLine("usage: unity-check <dir> --changed <files...> [--also <files...>]"); return 2; }
var dir = args[0];
var changed = new List<string>();
var also = new List<string>();
var into = changed;
foreach (var a in args.Skip(1)) { if (a == "--changed") into = changed; else if (a == "--also") into = also; else into.Add(a); }

var wanted = new HashSet<string> { "CS0102", "CS0111", "CS0101" };
var trees = new List<SyntaxTree>();
var rels = new Dictionary<SyntaxTree, string>();
foreach (var f in changed.Concat(also))
{
    var path = Path.Combine(dir, f);
    if (!File.Exists(path)) continue;
    var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(path), new CSharpParseOptions(LanguageVersion.Latest), path);
    trees.Add(tree); rels[tree] = f;
}
var changedSet = new HashSet<string>(changed);
var count = 0;
void Emit(SyntaxTree? tree, Diagnostic d)
{
    var span = d.Location.GetLineSpan();
    var file = tree != null && rels.TryGetValue(tree, out var r) ? r : span.Path;
    if (!changedSet.Contains(file) && !(d.AdditionalLocations.Any())) return;
    Console.WriteLine(JsonSerializer.Serialize(new { file, line = span.StartLinePosition.Line + 1, col = span.StartLinePosition.Character + 1, code = d.Id, message = d.GetMessage() }));
    count++;
}
// Syntax errors of the changed files (the rest only supplies members).
foreach (var t in trees.Where(t => changedSet.Contains(rels[t])))
    foreach (var d in t.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)) Emit(t, d);
// Declaration errors across the changed files and their partial parts.
var comp = CSharpCompilation.Create("check", trees, new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
foreach (var d in comp.GetDeclarationDiagnostics().Where(d => wanted.Contains(d.Id)))
    Emit(d.Location.SourceTree, d);
return count == 0 ? 0 : 1;
