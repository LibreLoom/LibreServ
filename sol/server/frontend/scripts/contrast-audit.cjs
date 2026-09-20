const { readdirSync, readFileSync, statSync } = require("fs");
const { join } = require("path");
const acorn = require("acorn");
const jsx = require("acorn-jsx");

const root = "src";
const issues = [];

const COMPONENT_SURFACE = {
  Card: "secondary",
  HeaderCard: "secondary",
  ModalCard: "secondary",
  SettingsCard: "secondary",
  SetupWizard: "primary",
  BaseCard: "secondary",
  Button: "secondary",
  Toggle: "secondary",
  FormInput: "secondary",
  FieldLabel: "primary",
  MetricCard: "secondary",
  Pill: "secondary",
  Callout: "secondary",
};

function walkDir(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const s = statSync(path);
    if (s.isDirectory()) walkDir(path);
    else if (entry.endsWith(".jsx")) {
      try {
        auditFile(path);
      } catch (e) {
        console.error(`Failed to parse ${path}: ${e.message}`);
      }
    }
  }
}

function getStaticClassValue(node) {
  if (!node) return "";
  if (node.type === "Literal") return String(node.value);
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.raw).join("");
  }
  return "";
}

function tokens(cls) {
  return cls.split(/\s+/).map((t) => t.replace(/^!/, "").replace(/!$/, ""));
}

function analyzeSurface(cls) {
  const toks = tokens(cls);
  if (toks.includes("bg-secondary")) return { surface: "secondary", kind: "full" };
  if (toks.includes("bg-primary")) return { surface: "primary", kind: "full" };
  // Any other full bg-* (bg-accent, bg-success, etc.) resets the tracked surface
  for (const t of toks) {
    if (/^bg-[a-z]+$/.test(t)) return { surface: null, kind: "other" };
    // opacity tint
    if (/^bg-[a-z]+\//.test(t)) return { surface: null, kind: "tint" };
  }
  return { surface: null, kind: null };
}

function tagName(opening) {
  if (!opening || !opening.name) return null;
  if (opening.name.type === "JSXIdentifier") return opening.name.name;
  if (opening.name.type === "JSXMemberExpression" && opening.name.object?.type === "JSXIdentifier") {
    return opening.name.object.name;
  }
  return null;
}

function isNative(tag) {
  return tag && tag[0] === tag[0].toLowerCase();
}

function auditFile(path) {
  const code = readFileSync(path, "utf8");
  const parser = acorn.Parser.extend(jsx());
  const ast = parser.parse(code, { sourceType: "module", ecmaVersion: "latest", locations: true });

  function visit(node, inheritedSurface, inheritedKind) {
    if (!node || typeof node !== "object") return;

    let currentSurface = inheritedSurface;
    let currentKind = inheritedKind;
    let cls = "";
    let line = node.loc ? node.loc.start.line : "?";
    let tag = null;

    if (node.type === "JSXElement") {
      const opening = node.openingElement;
      if (opening) {
        tag = tagName(opening);
        line = opening.loc ? opening.loc.start.line : line;
        const classAttr = opening.attributes.find((a) => a.type === "JSXAttribute" && a.name?.name === "className");
        if (classAttr) {
          cls = getStaticClassValue(classAttr.value);
        }
        const analysis = analyzeSurface(cls);
        if (analysis.kind === "full") {
          currentSurface = analysis.surface;
          currentKind = "full";
        } else if (analysis.kind === "other") {
          currentSurface = null;
          currentKind = "other";
        } else if (analysis.kind === "tint") {
          currentKind = "tint";
        } else if (tag && COMPONENT_SURFACE[tag] && !isNative(tag)) {
          // Allow the `surface` prop to override a component's default surface.
          const surfaceAttr = opening.attributes.find((a) => a.type === "JSXAttribute" && a.name?.name === "surface");
          const surfaceProp = surfaceAttr && getStaticClassValue(surfaceAttr.value);
          currentSurface = surfaceProp === "primary" || surfaceProp === "secondary" ? surfaceProp : COMPONENT_SURFACE[tag];
          currentKind = "full";
        }
      }
    }

    if (currentSurface && currentKind === "full" && cls && tag && isNative(tag)) {
      const toks = tokens(cls);
      if (currentSurface === "primary" && toks.includes("text-primary")) {
        issues.push(`${path}:${line}: text-primary inside bg-primary`);
      }
      if (currentSurface === "secondary" && toks.includes("text-secondary")) {
        issues.push(`${path}:${line}: text-secondary inside bg-secondary`);
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach((c) => visit(c, currentSurface, currentKind));
      } else if (child && typeof child === "object") {
        visit(child, currentSurface, currentKind);
      }
    }
  }

  visit(ast, null, null);
}

walkDir(root);

console.log("=== AST-based contrast failures ===");
issues.forEach((x) => console.log(x));
console.log(`Count: ${issues.length}`);
