import {
  CapabilityError,
  type AdbExecutor,
  type DeviceInfo,
  type DeviceProvider,
  type DeviceScreenshot,
  type DeviceSelector,
  type UiDump,
} from '../../types.js';
import { parseAdbDevices, parsePngSize } from './adb.js';
import { findNode, nodeCenter, parseUiDump } from './ui-dump.js';

const KEY_ALIASES: Record<string, string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  enter: 'KEYCODE_ENTER',
  menu: 'KEYCODE_MENU',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  delete: 'KEYCODE_DEL',
  tab: 'KEYCODE_TAB',
};

export class AndroidDeviceProvider implements DeviceProvider {
  constructor(private readonly adb: AdbExecutor) {}

  private async devices(): Promise<DeviceInfo[]> {
    return parseAdbDevices((await this.adb.exec(['devices', '-l'])).toString('utf8'));
  }

  async resolveSerial(explicit?: string): Promise<string> {
    const online = (await this.devices()).filter((device) => device.state === 'device');
    if (explicit) {
      if (online.some((device) => device.serial === explicit)) return explicit;
      throw new CapabilityError('device_offline', `device ${explicit} is not online`);
    }
    if (online.length === 1) return online[0]!.serial;
    if (online.length === 0) throw new CapabilityError('device_offline', 'no online device');
    throw new CapabilityError('device_ambiguous', 'multiple devices are online; pass a serial');
  }

  list(): Promise<DeviceInfo[]> {
    return this.devices();
  }

  async screenshot(serial: string): Promise<DeviceScreenshot> {
    const png = await this.adb.exec(['-s', serial, 'exec-out', 'screencap', '-p'], {
      binary: true,
    });
    return { png, ...parsePngSize(png) };
  }

  async uiDump(serial: string): Promise<UiDump> {
    await this.adb.exec([
      '-s',
      serial,
      'shell',
      'uiautomator',
      'dump',
      '/sdcard/paboot-window.xml',
    ]);
    const xml = (
      await this.adb.exec(['-s', serial, 'exec-out', 'cat', '/sdcard/paboot-window.xml'])
    ).toString('utf8');
    return { xml, nodes: parseUiDump(xml) };
  }

  async tap(serial: string, x: number, y: number): Promise<void> {
    await this.adb.exec(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)]);
  }

  async tapSelector(serial: string, selector: DeviceSelector): Promise<{ x: number; y: number }> {
    const { nodes } = await this.uiDump(serial);
    const point = nodeCenter(findNode(nodes, selector));
    await this.tap(serial, point.x, point.y);
    return point;
  }

  async inputText(serial: string, text: string): Promise<void> {
    if (!/^[\x20-\x7e]+$/.test(text)) {
      throw new CapabilityError(
        'input_text_unsupported',
        'adb input text only supports printable ASCII',
      );
    }
    if (/[;&|<>$`\\"']/.test(text)) {
      throw new CapabilityError('input_text_unsupported', 'text contains shell metacharacters');
    }
    await this.adb.exec(['-s', serial, 'shell', 'input', 'text', text.replace(/ /g, '%s')]);
  }

  async keyEvent(serial: string, key: string): Promise<void> {
    const trimmed = key.trim();
    const code = /^\d+$/.test(trimmed)
      ? trimmed
      : KEY_ALIASES[trimmed.toLowerCase()] ??
        (trimmed.startsWith('KEYCODE_') ? trimmed : `KEYCODE_${trimmed.toUpperCase()}`);
    await this.adb.exec(['-s', serial, 'shell', 'input', 'keyevent', code]);
  }

  async launchApp(serial: string, pkg: string): Promise<void> {
    await this.adb.exec([
      '-s',
      serial,
      'shell',
      'monkey',
      '-p',
      pkg,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
  }

  async logcat(serial: string, lines: number): Promise<string> {
    const count = Math.min(Math.max(1, Math.floor(lines)), 2_000);
    return (await this.adb.exec(['-s', serial, 'logcat', '-d', '-t', String(count)])).toString(
      'utf8',
    );
  }

  async currentActivity(serial: string): Promise<string> {
    const windows = (await this.adb.exec(['-s', serial, 'shell', 'dumpsys', 'window'])).toString(
      'utf8',
    );
    const focus = /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^}]+)\}/.exec(windows);
    if (focus?.[1]) return focus[1];
    const activity = (
      await this.adb.exec(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'])
    ).toString('utf8');
    const resumed = /mResumedActivity: [^ ]+ [^ ]+ ([^ ]+)/.exec(activity);
    if (resumed?.[1]) return resumed[1];
    throw new CapabilityError('activity_unknown', 'could not read the current activity');
  }
}
