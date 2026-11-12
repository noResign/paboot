/**
 * A domain (end kind) owns the conventions seeded when an end is activated.
 * Adding a domain = adding one entry here; routing does not branch on kind.
 */
export interface DomainTemplate {
  id: string;
  name: string;
  /** Seeded into `ends/<id>/knowledge/` as kind=convention on activation. */
  conventions: ReadonlyArray<{ title: string; body: string }>;
}

const ANDROID = `# Android 约定

- 构建产物不要提交；使用项目自带的 Gradle wrapper。
- 改动后优先在本地跑单元测试与 lint。
`;

export const DOMAIN_TEMPLATES: readonly DomainTemplate[] = [
  {
    id: 'android',
    name: 'Android',
    conventions: [{ title: 'Android 约定', body: ANDROID }],
  },
  { id: 'ios', name: 'iOS', conventions: [] },
  { id: 'web', name: 'Web 前端', conventions: [] },
  { id: 'api', name: '后端 API', conventions: [] },
  { id: 'data', name: '数据 / 脚本', conventions: [] },
  { id: 'test', name: '测试', conventions: [] },
];

export function domainById(id: string): DomainTemplate | undefined {
  return DOMAIN_TEMPLATES.find((domain) => domain.id === id);
}
