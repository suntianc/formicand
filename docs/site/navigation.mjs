export const navigation = [
  {
    zh: "使用",
    en: "Use",
    pages: [
      ["docs/README.md", "概览", "Overview"],
      ["README.zh-CN.md", "产品说明与上手", "Product guide"]
    ]
  },
  {
    zh: "开发",
    en: "Develop",
    collapsed: true,
    pages: [
      ["docs/development.md", "开发与架构", "Development and architecture"],
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

export const userGuideFiles = new Set([
  "README.md",
  "README.zh-CN.md",
  "docs/README.md",
  "docs/en/README.md"
]);
