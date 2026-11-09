export class CapabilityError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export interface DeviceInfo {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transport?: string;
}

export interface DeviceScreenshot {
  png: Buffer;
  width: number;
  height: number;
}

export interface UiBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface UiNode {
  text?: string;
  resourceId?: string;
  contentDesc?: string;
  className?: string;
  clickable: boolean;
  bounds: UiBounds;
}

export interface UiDump {
  xml: string;
  nodes: UiNode[];
}

export interface DeviceSelector {
  text?: string;
  resourceId?: string;
  contentDesc?: string;
  className?: string;
}

export interface DeviceProvider {
  list(): Promise<DeviceInfo[]>;
  resolveSerial(explicit?: string): Promise<string>;
  screenshot(serial: string): Promise<DeviceScreenshot>;
  uiDump(serial: string): Promise<UiDump>;
  tap(serial: string, x: number, y: number): Promise<void>;
  tapSelector(serial: string, selector: DeviceSelector): Promise<{ x: number; y: number }>;
  inputText(serial: string, text: string): Promise<void>;
  keyEvent(serial: string, key: string): Promise<void>;
  launchApp(serial: string, pkg: string): Promise<void>;
  logcat(serial: string, lines: number): Promise<string>;
  currentActivity(serial: string): Promise<string>;
}

/** Narrow seam so provider tests do not need a real adb binary. */
export interface AdbExecutor {
  exec(args: string[], options?: { binary?: boolean; timeoutMs?: number }): Promise<Buffer>;
}
