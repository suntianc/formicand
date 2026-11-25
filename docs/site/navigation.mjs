export const navigation = [
  {
    zh: "使用",
    en: "Use",
    pages: [
      ["docs/README.md", "概览", "Overview"],
      ["docs/getting-started.md", "上手", "Getting started"],
      ["docs/configuration.md", "配置", "Configuration"],
      ["docs/capabilities.md", "内置能力", "Built-in capabilities"]
    ]
  },
  {
    zh: "开发",
    en: "Develop",
    collapsed: true,
    pages: [
      ["docs/architecture.md", "架构与代码地图", "Architecture and code map"],
      ["docs/development.md", "开发", "Development"],
      ["docs/testing.md", "测试", "Testing"],
      ["GLOSSARY.md", "产品术语", "Product glossary (Chinese)"],
      ["CONTRIBUTING.md", "参与贡献", "Contributing"]
    ]
  },
  {
    zh: "过程记录",
    en: "Records (Chinese)",
    collapsed: true,
    pages: [
      ["docs/development-handoffs.md", "开发交接", "Handoffs"],
      ["docs/pitfalls/README.md", "项目坑点", "Pitfalls"],
      ["docs/adr-history.md", "架构决定历史", "Decision history"],
      ["docs/retrospectives.md", "复盘", "Retrospectives"]
    ]
  }
];

const userNames = ["README", "getting-started", "configuration", "capabilities"];
export const userGuideFiles = new Set([
  "README.md",
  "README.zh-CN.md",
  ...userNames.flatMap((name) => [`docs/${name}.md`, `docs/en/${name}.md`])
]);
