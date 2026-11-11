import { CAPABILITIES, type CapabilityDescriptor } from '../capabilities/registry.js';

/**
 * A domain (end kind) owns built-in conventions and declares which
 * capabilities it can provide. Adding a domain = adding one entry here plus
 * capability descriptors that reference it; routing does not branch on kind.
 */
export interface DomainTemplate {
  id: string;
  name: string;
  /** Seeded into `ends/<id>/knowledge/` as kind=convention on activation. */
  conventions: ReadonlyArray<{ title: string; body: string }>;
  /** Enabled automatically when the end is activated. */
  defaultCapabilities: readonly string[];
}

const ANDROID = `# Android 约定

- 构建产物不要提交；使用项目自带的 Gradle wrapper。
- 设备操作前先确认 adb 设备在线；截图 / 点击属于可审计的副作用。
`;

export const DOMAIN_TEMPLATES: readonly DomainTemplate[] = [
  {
    id: 'android',
    name: 'Android',
    conventions: [{ title: 'Android 约定', body: ANDROID }],
    defaultCapabilities: ['android-device'],
  },
  {
    id: 'ios',
    name: 'iOS',
    conventions: [],
    defaultCapabilities: [],
  },
  {
    id: 'web',
    name: 'Web 前端',
    conventions: [],
    defaultCapabilities: [],
  },
  {
    id: 'api',
    name: '后端 API',
    conventions: [],
    defaultCapabilities: [],
  },
  {
    id: 'data',
    name: '数据 / 脚本',
    conventions: [],
    defaultCapabilities: [],
  },
  {
    id: 'test',
    name: '测试',
    conventions: [],
    defaultCapabilities: [],
  },
];

export function domainById(id: string): DomainTemplate | undefined {
  return DOMAIN_TEMPLATES.find((domain) => domain.id === id);
}

/** Capabilities a domain can actually mount (only implemented providers). */
export function capabilitiesForDomain(id: string): CapabilityDescriptor[] {
  return CAPABILITIES.filter((capability) => capability.domains?.includes(id));
}
