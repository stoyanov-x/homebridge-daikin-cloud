import { describe, expect, it, vi } from 'vitest';
import { DaikinWebSocket } from '../../../src/api/daikin-websocket';

function makeClient() {
  const oauth = {
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
    isAuthenticated: () => true,
    refreshToken: vi.fn(),
  };
  return new DaikinWebSocket(oauth as never);
}

/** handleMessage is private; message parsing is the only thing worth testing here. */
function deliver(client: DaikinWebSocket, payload: unknown): void {
  (client as unknown as { handleMessage: (data: Buffer) => void }).handleMessage(Buffer.from(JSON.stringify(payload)));
}

const groupPayload = (event: string) => ({
  event,
  eventType: 'update',
  groupId: 'group-1',
  siteId: 'site-1',
  data: { name: 'onOffMode', value: 'on', settable: true },
});

describe('DaikinWebSocket message parsing', () => {
  it('emits device_update for gateway management point characteristics', () => {
    const client = makeClient();
    const handler = vi.fn();
    client.on('device_update', handler);

    deliver(client, {
      event: 'gateway:managementpoint:characteristic',
      eventType: 'update',
      gatewayDeviceId: 'device-1',
      embeddedId: 'climateControl',
      managementPointId: 'climateControl',
      data: { name: 'onOffMode', value: 'on' },
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-1',
      embeddedId: 'climateControl',
      characteristicName: 'onOffMode',
    }));
  });

  // Group characteristics arrive on the same socket; the app's
  // NotificationMessageEvent enum names them `group:characteristic`
  it('emits group_update for group characteristics', () => {
    const client = makeClient();
    const handler = vi.fn();
    client.on('group_update', handler);

    deliver(client, groupPayload('group:characteristic'));

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group-1',
      siteId: 'site-1',
      characteristicName: 'onOffMode',
      data: expect.objectContaining({ value: 'on' }),
    }));
  });

  it('ignores events it does not know', () => {
    const client = makeClient();
    const deviceHandler = vi.fn();
    const groupHandler = vi.fn();
    client.on('device_update', deviceHandler);
    client.on('group_update', groupHandler);

    deliver(client, { event: 'site:something:else', data: { name: 'onOffMode', value: 'on' } });

    expect(deviceHandler).not.toHaveBeenCalled();
    expect(groupHandler).not.toHaveBeenCalled();
  });

  it('ignores payloads that are not JSON', () => {
    const client = makeClient();
    const handler = vi.fn();
    client.on('device_update', handler);

    const priv = client as unknown as { handleMessage: (data: Buffer) => void };
    expect(() => priv.handleMessage(Buffer.from('not json'))).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
