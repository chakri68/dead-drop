/**
 * Minimal declarations for the browser APIs TypeScript's DOM lib doesn't ship.
 * Hand-written rather than pulled from DefinitelyTyped to keep the dependency
 * count where the spec wants it, and narrowed to only what this project calls.
 */

interface MediaTrackConstraintSet {
  torch?: boolean;
}

interface MediaTrackCapabilities {
  torch?: boolean;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  value?: DataView;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
}

interface Bluetooth {
  getAvailability?(): Promise<boolean>;
  requestDevice(options: {
    filters?: Array<{ services?: string[]; name?: string }>;
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }): Promise<BluetoothDevice>;
}

interface Navigator {
  bluetooth: Bluetooth;
}
