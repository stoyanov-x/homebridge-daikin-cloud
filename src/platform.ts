import type { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AccessoryFactory } from './device';

import { resolve } from 'node:path';
import { StringUtils } from './utils/strings';

import fs from 'node:fs';
import type { DaikinCloudDevice, DaikinControllerConfig } from './api';
import { DaikinCloudRepo, DaikinCloudController, DAIKIN_MOBILE_CONFIG, DAIKIN_OIDC_CONFIG } from './api';
import { UpdateMapper } from './utils/update-mapper';
import type { PluginConfig } from './config/config-manager';
import { ConfigManager } from './config/config-manager';
import {
  ONE_MINUTE_MS,
  ONE_HOUR_MS,
  DEFAULT_UPDATE_INTERVAL_MINUTES,
  DEFAULT_FORCE_UPDATE_DELAY_MS,
  WEBSOCKET_FALLBACK_POLL_INTERVAL_MS,
  DISCOVERY_RETRY_INITIAL_DELAY_MS,
  DISCOVERY_RETRY_MAX_DELAY_MS,
  RATE_LIMIT_WARNING_THRESHOLD,
} from './constants';

/** "9h 12m" — for staleness messages, where an exact millisecond count is noise. */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / ONE_MINUTE_MS);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

export type DaikinCloudAccessoryContext = {
    device: DaikinCloudDevice;
};

export class DaikinCloudPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory<DaikinCloudAccessoryContext>[] = [];

  public readonly storagePath: string = '';
  public controller: DaikinCloudController | undefined;

  public readonly updateIntervalDelay: number;
  private updateInterval: NodeJS.Timeout | undefined;
  private forceUpdateTimeout: NodeJS.Timeout | undefined;
  private discoveryRetryTimeout: NodeJS.Timeout | undefined;
  private discoveryRetryDelay = DISCOVERY_RETRY_INITIAL_DELAY_MS;
  private discoveryAttempts = 0;
  private lastDiscoveryError: string | undefined;
  private lastSuccessfulUpdateAt: Date | undefined;
  private stalenessMonitor: NodeJS.Timeout | undefined;
  private stalenessWarnedAt = 0;
  private isShuttingDown = false;
  private readonly accessoryFactory: AccessoryFactory;
  private readonly updateMapper: UpdateMapper;
  private readonly authMode: 'developer_portal' | 'mobile_app';
  private readonly deviceListeners = new Map<string, () => void>();
  private websocketConnected = false;

  constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API,
  ) {
    this.log.info('--- Daikin info for debugging reasons (enable Debug Mode for more logs) ---');

    this.log.debug('[Platform] Initializing platform:', this.config.name);

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.storagePath = api.user.storagePath();
    this.updateIntervalDelay = ONE_MINUTE_MS * (this.config.updateIntervalInMinutes || DEFAULT_UPDATE_INTERVAL_MINUTES);
    this.accessoryFactory = new AccessoryFactory(this);
    this.updateMapper = new UpdateMapper(this.log, this.Service, this.Characteristic);

    // Determine authentication mode
    this.authMode = this.config.authMode === 'mobile_app' ? 'mobile_app' : 'developer_portal';
    this.log.info(`[Config] Authentication mode: ${this.authMode}`);

    // Validate configuration
    const configManager = new ConfigManager(this.config as PluginConfig);
    const validation = configManager.validate();
    for (const warning of validation.warnings) {
      this.log.warn(`[Config] ${warning}`);
    }

    // Check if credentials are configured based on auth mode
    if (this.authMode === 'mobile_app') {
      if (!this.config.daikinEmail || !this.config.daikinPassword) {
        this.log.warn('[Config] Daikin email and/or password not configured.');
        this.log.warn('[Config] Please configure the plugin using the Homebridge UI.');
        this.log.info('--------------- End Daikin info for debugging reasons --------------------');
        return;
      }
    } else {
      if (!this.config.clientId || !this.config.clientSecret) {
        this.log.warn('[Config] Client ID and/or Client Secret not configured.');
        this.log.warn('[Config] Please configure the plugin using the Homebridge UI.');
        this.log.info('--------------- End Daikin info for debugging reasons --------------------');
        return;
      }
    }

    // Use different token file for mobile auth to avoid conflicts
    const tokenFileName = this.authMode === 'mobile_app'
      ? '.daikin-mobile-tokenset'
      : '.daikin-controller-cloud-tokenset';
    const tokenFilePath = resolve(this.storagePath, tokenFileName);

    const daikinCloudControllerConfig: DaikinControllerConfig = {
      authMode: this.authMode,
      tokenFilePath,
      // Developer Portal fields
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      callbackServerExternalAddress: this.config.callbackServerExternalAddress,
      callbackServerPort: this.config.callbackServerPort || 8582,
      oidcCallbackServerBindAddr: this.config.oidcCallbackServerBindAddr,
      // Mobile App fields
      email: this.config.daikinEmail,
      password: this.config.daikinPassword,
    };

    this.log.debug('[Config] Homebridge config', this.getPrivacyFriendlyConfig(this.config));

    fs.stat(tokenFilePath, (err, stats) => {
      if (err) {
        this.log.debug('[Config] Token file does NOT exist.');
        if (this.authMode === 'developer_portal') {
          this.log.debug('[Config] Please authenticate via the Homebridge UI.');
        }
      } else {
        this.log.debug(`[Config] Token file exists, last modified: ${stats.mtime}`);
      }
    });

    this.controller = new DaikinCloudController(daikinCloudControllerConfig);

    // Spelled out because the first thing worth checking in an outage is whether
    // the endpoints the plugin uses answer at all.
    const apiBaseUrl = this.authMode === 'mobile_app' ? DAIKIN_MOBILE_CONFIG.apiBaseUrl : DAIKIN_OIDC_CONFIG.apiBaseUrl;
    const websocketUrl = this.authMode === 'mobile_app' ? DAIKIN_MOBILE_CONFIG.websocketUrl : undefined;
    this.log.info(`[Config] Daikin Cloud API: ${apiBaseUrl}${websocketUrl ? ` (WebSocket: ${websocketUrl})` : ''}`);

    this.api.on('didFinishLaunching', async () => {
      if (!this.controller) {
        return;
      }

      const onInvalidGrantError = () => this.onInvalidGrantError(tokenFilePath);

      // Handle authentication based on mode
      if (!this.controller.isAuthenticated()) {
        if (this.authMode === 'mobile_app') {
          // For mobile auth, automatically authenticate using stored credentials
          this.log.info('[Auth] Authenticating with Daikin Cloud using mobile app credentials...');
          try {
            await this.controller.authenticateMobile();
            this.log.info('[Auth] Authentication successful!');
          } catch (error) {
            // The login itself can fail for reasons that pass: the endpoint being
            // unreachable, a 30s request timeout, throttling. Enter the discovery
            // loop anyway - it retries, and it re-authenticates when it can - rather
            // than leaving the plugin inert until someone restarts Homebridge.
            this.log.error(`[Auth] Authentication failed: ${(error as Error).message}`);
            await this.startDeviceDiscovery(this.controller, onInvalidGrantError);
            this.log.info('--------------- End Daikin info for debugging reasons --------------------');
            return;
          }
        } else {
          this.log.warn('[Auth] Not authenticated. Please use the Homebridge UI to authenticate with Daikin Cloud.');
          this.log.info('--------------- End Daikin info for debugging reasons --------------------');
          return;
        }
      }

      this.controller.on('rate_limit_status', (rateLimitStatus) => {
        if (rateLimitStatus.remainingDay && rateLimitStatus.remainingDay <= RATE_LIMIT_WARNING_THRESHOLD) {
          this.log.warn(`[Rate Limit] Rate limit almost reached, you only have ${rateLimitStatus.remainingDay} calls left today`);
        }
        // Only show minute limits if available (Developer Portal mode)
        const minuteInfo = rateLimitStatus.limitMinute !== undefined
          ? ` -- this minute: ${rateLimitStatus.remainingMinute}/${rateLimitStatus.limitMinute}`
          : '';
        this.log.debug(`[Rate Limit] Remaining calls today: ${rateLimitStatus.remainingDay}/${rateLimitStatus.limitDay}${minuteInfo}`);
      });

      this.controller.on('error', (error) => {
        this.log.error(`[Error] ${error}`);
      });

      this.controller.on('log', (message) => {
        this.log.info(message);
      });

      // WebSocket event handlers
      this.controller.on('websocket_connected', () => {
        this.websocketConnected = true;
        this.log.info('[WebSocket] Connected - receiving real-time updates');
        // Restore the normal polling interval now that real-time updates are flowing
        this.restartUpdateDevicesInterval();
      });

      this.controller.on('websocket_disconnected', (info?: { reconnecting: boolean }) => {
        this.websocketConnected = false;
        if (info?.reconnecting) {
          this.log.debug('[WebSocket] Disconnected, attempting to reconnect...');
          // Shorten the polling interval while WebSocket is down so the plugin
          // doesn't miss state changes for the full configured interval (default
          // 15 min). Once WebSocket reconnects, websocket_connected restores it.
          this.restartUpdateDevicesInterval(WEBSOCKET_FALLBACK_POLL_INTERVAL_MS);
        } else {
          this.log.info('[WebSocket] Disconnected');
          this.restartUpdateDevicesInterval(WEBSOCKET_FALLBACK_POLL_INTERVAL_MS);
        }
      });

      this.controller.on('websocket_device_update', (update) => {
        this.log.debug(`[WebSocket] Device update: ${update.deviceId} - ${update.characteristicName}`, JSON.stringify(update.data));
        this.handleWebSocketDeviceUpdate(update);
      });

      // Group events cannot be mapped to a single accessory (no group-to-device
      // map is fetched), so use them as a hint that something changed and let the
      // debounced force-update reconcile. Cheap: rapid bursts collapse into one poll.
      this.controller.on('websocket_group_update', (update) => {
        this.log.debug(`[WebSocket] Group update: ${update.groupId} - ${update.characteristicName} (refreshing devices)`);
        this.forceUpdateDevices();
      });

      await this.startDeviceDiscovery(this.controller, onInvalidGrantError);

      this.log.info('--------------- End Daikin info for debugging reasons --------------------');
    });

    // Shutdown handler: clean up timers, WebSocket, and device listeners on platform shutdown
    this.api.on('shutdown', () => {
      this.log.debug('[Platform] Shutting down, cleaning up resources...');
      this.isShuttingDown = true;
      clearInterval(this.updateInterval);
      clearInterval(this.stalenessMonitor);
      this.stalenessMonitor = undefined;
      clearTimeout(this.forceUpdateTimeout);
      clearTimeout(this.discoveryRetryTimeout);
      this.controller?.disableWebSocket();
      for (const [uuid, listener] of this.deviceListeners) {
        const accessory = this.accessories.find(a => a.UUID === uuid);
        if (accessory?.context.device) {
          accessory.context.device.removeListener('updated', listener);
        }
      }
      this.deviceListeners.clear();
    });
  }

  public configureAccessory(accessory: PlatformAccessory) {
    this.log.info('[Platform] Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory as PlatformAccessory<DaikinCloudAccessoryContext>);
  }

  private async discoverDevices(controller: DaikinCloudController, onInvalidGrantError: () => void): Promise<DaikinCloudDevice[]> {
    try {
      return await controller.getCloudDevices();
    } catch (error) {
      if (error instanceof Error) {
        const message = `[API Syncing] Failed to get cloud devices from Daikin Cloud: ${error.message}`;
        this.log.error(message);
        this.lastDiscoveryError = error.message;

        if (error.message.includes('invalid_grant')) {
          onInvalidGrantError();
        }
      }
      return [];
    }
  }

  /**
   * A rejected token set looks the same whatever caused it: expired access token
   * plus a refresh token the cloud no longer accepts (rotated, revoked, or the
   * account was re-configured). Waiting will not fix that, so mobile-app mode
   * logs in again with the credentials from the config.
   */
  private isAuthFailure(message: string | undefined): boolean {
    if (!message) {
      return false;
    }
    return /unauthorized|not authenticated|invalid_grant|refresh token|invalid_client/i.test(message);
  }

  private async reauthenticate(controller: DaikinCloudController): Promise<boolean> {
    if (this.authMode !== 'mobile_app') {
      this.log.warn('[Auth] Daikin Cloud rejects the stored token and developer-portal mode cannot log in by itself. Re-authenticate via the Homebridge UI.');
      return false;
    }

    try {
      this.log.warn('[Auth] Stored token set is no longer accepted, logging in again with the configured credentials...');
      await controller.authenticateMobile();
      this.log.info('[Auth] Re-authenticated with Daikin Cloud');
      return true;
    } catch (error) {
      this.log.error(`[Auth] Re-authentication failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Fetch devices, then start polling and the WebSocket once they are known.
   *
   * Discovery is the one call the plugin cannot recover from on its own: when it
   * fails, no accessory is bound to a live device, no poll timer is scheduled
   * and the WebSocket is never enabled, so HomeKit keeps reporting the values
   * persisted at the previous shutdown. Daikin's cloud does go unreachable, and
   * a Homebridge restart during such an outage is enough to land here, so retry
   * with backoff until discovery succeeds.
   */
  private async startDeviceDiscovery(
    controller: DaikinCloudController,
    onInvalidGrantError: () => void,
    allowReauth = true,
  ): Promise<void> {
    this.lastDiscoveryError = undefined;
    const devices: DaikinCloudDevice[] = await this.discoverDevices(controller, onInvalidGrantError);

    if (devices.length > 0) {
      if (this.discoveryAttempts > 0) {
        this.log.info(`[API Syncing] Device discovery recovered after ${this.discoveryAttempts} failed attempt(s)`);
        this.discoveryAttempts = 0;
      }
      this.discoveryRetryDelay = DISCOVERY_RETRY_INITIAL_DELAY_MS;
      this.lastSuccessfulUpdateAt = new Date();
      this.createDevices(devices);
      this.startUpdateDevicesInterval();

      // Enable WebSocket for real-time updates (unless explicitly disabled)
      if (this.config.enableWebSocket !== false) {
        await this.enableWebSocket();
      }
      return;
    }

    if (this.isShuttingDown) {
      return;
    }

    // Retry immediately after a successful login; the backoff below is for an
    // unreachable cloud, which credentials cannot fix.
    if (allowReauth && this.isAuthFailure(this.lastDiscoveryError) && await this.reauthenticate(controller)) {
      await this.startDeviceDiscovery(controller, onInvalidGrantError, false);
      return;
    }

    if (this.discoveryRetryTimeout) {
      return;
    }

    this.discoveryAttempts++;
    if (this.discoveryAttempts === 1) {
      // Say what the user will see, not just that a call failed: the accessories
      // stay published with the characteristic values from the last shutdown.
      this.log.warn('[API Syncing] No devices discovered: HomeKit will keep showing the state cached at the last shutdown until discovery succeeds');
    }

    const delay = this.discoveryRetryDelay;
    this.discoveryRetryDelay = Math.min(delay * 2, DISCOVERY_RETRY_MAX_DELAY_MS);
    this.log.warn(`[API Syncing] No devices discovered, retrying in ${Math.round(delay / ONE_MINUTE_MS)} minute(s)`);

    this.discoveryRetryTimeout = setTimeout(() => {
      this.discoveryRetryTimeout = undefined;
      void this.startDeviceDiscovery(controller, onInvalidGrantError);
    }, delay);
  }

  private createDevices(devices: DaikinCloudDevice[]) {
    for (const device of devices) {
      try {
        const deviceId = device.getId();
        const uuid = this.api.hap.uuid.generate(deviceId);
        const deviceModel: string = device.getDescription().deviceModel;

        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        this.log.debug('Create Device', deviceModel, JSON.stringify(DaikinCloudRepo.maskSensitiveCloudDeviceData(device.desc), null, 4));

        if (this.isExcludedDevice(this.config.excludedDevicesByDeviceId, deviceId)) {
          this.log.info(`[Platform] Device ${deviceModel} (id: ${deviceId}) is excluded, don't add accessory`);
          if (existingAccessory) {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
          }
          continue;
        }

        if (existingAccessory) {
          this.log.info(`[Platform] Restoring existing accessory from cache: ${existingAccessory.displayName} (id: ${deviceId})`);

          // Remove old event listener before reassigning device
          this.removeDeviceListener(existingAccessory);

          existingAccessory.context.device = device;
          this.api.updatePlatformAccessories([existingAccessory]);

          const { profile } = this.accessoryFactory.createAccessory(existingAccessory);
          this.log.debug(`[Platform] Created ${profile.displayName} accessory`);

        } else {
          const climateControlEmbeddedId = device.desc.managementPoints.find(mp => mp.managementPointType === 'climateControl')?.embeddedId || 'climateControl';
          const nameData = device.getData(climateControlEmbeddedId, 'name', undefined).value as string | undefined;
          const displayName = StringUtils.isEmpty(nameData) ? deviceModel : nameData!;
          this.log.info(`[Platform] Adding new accessory: ${displayName} (id: ${deviceId})`);
          const accessory = new this.api.platformAccessory<DaikinCloudAccessoryContext>(displayName, uuid);
          accessory.context.device = device;

          const { profile } = this.accessoryFactory.createAccessory(accessory);
          this.log.debug(`[Platform] Created ${profile.displayName} accessory`);

          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      } catch (error) {
        if (error instanceof Error) {
          this.log.error(`[Platform] Failed to create accessory: ${error.message}`);
          this.log.debug('[Platform] Error details:', error.stack);
          this.log.debug('[Platform] Device JSON:', JSON.stringify(DaikinCloudRepo.maskSensitiveCloudDeviceData(device.desc), null, 2));
        }
      }
    }
  }

  private removeDeviceListener(accessory: PlatformAccessory<DaikinCloudAccessoryContext>) {
    const existingListener = this.deviceListeners.get(accessory.UUID);
    if (existingListener && accessory.context.device) {
      accessory.context.device.removeListener('updated', existingListener);
      this.deviceListeners.delete(accessory.UUID);
    }
  }

  registerDeviceListener(accessory: PlatformAccessory<DaikinCloudAccessoryContext>, listener: () => void) {
    this.deviceListeners.set(accessory.UUID, listener);
  }

  private async updateDevices() {
    if (!this.controller) {
      return;
    }
    try {
      await this.controller.updateAllDeviceData();
      this.lastSuccessfulUpdateAt = new Date();
      this.stalenessWarnedAt = 0;
    } catch (error) {
      // JSON.stringify(error) is just "{}" - an Error carries nothing enumerable.
      this.log.error(`[API Syncing] Failed to update devices data: ${(error as Error).message}`);
    }
  }

  /**
   * Warn when HomeKit's view of the devices has gone stale.
   *
   * A cloud outage otherwise looks like a working plugin showing the wrong
   * values: nothing throws on the HomeKit side, requests just keep failing. The
   * warning repeats once an hour so it survives a log being cleared.
   */
  private startStalenessMonitor(): void {
    if (this.stalenessMonitor) {
      return;
    }

    const staleAfterMs = Math.max(this.updateIntervalDelay * 3, 15 * ONE_MINUTE_MS);
    const checkEveryMs = Math.min(this.updateIntervalDelay, 5 * ONE_MINUTE_MS);

    this.stalenessMonitor = setInterval(() => {
      const lastSuccess = this.lastSuccessfulUpdateAt;
      if (this.isShuttingDown || !lastSuccess) {
        return;
      }

      const staleForMs = Date.now() - lastSuccess.getTime();
      if (staleForMs < staleAfterMs) {
        return;
      }

      const now = Date.now();
      if (now - this.stalenessWarnedAt < ONE_HOUR_MS) {
        return;
      }

      this.stalenessWarnedAt = now;
      this.log.warn(
        `[API Syncing] No successful update for ${formatDuration(staleForMs)}: `
        + `HomeKit is still showing the state from ${lastSuccess.toISOString()}`,
      );
    }, checkEveryMs);
  }

  forceUpdateDevices(delay: number = Math.max(0, this.config.forceUpdateDelay || DEFAULT_FORCE_UPDATE_DELAY_MS)) {
    // Trailing debounce: reset the timer on every change so a burst of rapid
    // SETs (e.g. toggling power, fan speed and mode in quick succession)
    // collapses into a single poll fired `delay` ms after the *last* change,
    // instead of one poll per change. This avoids redundant API calls.
    if (this.forceUpdateTimeout) {
      clearTimeout(this.forceUpdateTimeout);
      this.log.debug(`[API Syncing] Force update rescheduled (debouncing rapid changes, delayed by ${delay}ms)`);
    } else {
      this.log.debug(`[API Syncing] Force update devices data (delayed by ${delay}ms)`);
      // Pause periodic polling while we wait for the change to settle; it is
      // restarted once the debounced update fires.
      clearInterval(this.updateInterval);
    }

    this.forceUpdateTimeout = setTimeout(async () => {
      this.forceUpdateTimeout = undefined;
      try {
        await this.updateDevices();
      } catch (error) {
        this.log.error(`[API Syncing] Force update failed: ${(error as Error).message}`);
      }
      this.startUpdateDevicesInterval();
    }, delay);
  }

  private startUpdateDevicesInterval(intervalMs?: number) {
    const delay = intervalMs ?? this.updateIntervalDelay;
    this.log.debug(`[API Syncing] (Re)starting update devices interval every ${delay / ONE_MINUTE_MS} minutes`);
    this.startStalenessMonitor();
    this.updateInterval = setInterval(async () => {
      try {
        await this.updateDevices();
      } catch (error) {
        this.log.error(`[API Syncing] Periodic update failed: ${(error as Error).message}`);
      }
    }, delay);
  }

  /**
   * Restart the periodic polling interval, optionally with a custom delay.
   * Clears the existing interval before starting a new one.
   */
  private restartUpdateDevicesInterval(intervalMs?: number): void {
    clearInterval(this.updateInterval);
    this.startUpdateDevicesInterval(intervalMs);
  }

  private async enableWebSocket() {
    if (!this.controller) {
      return;
    }

    try {
      this.log.info('[WebSocket] Enabling real-time updates...');
      await this.controller.enableWebSocket();
    } catch (error) {
      this.log.warn(`[WebSocket] Failed to enable: ${(error as Error).message}`);
      this.log.warn('[WebSocket] Falling back to polling-only mode');
    }
  }

  private isExcludedDevice(excludedDevicesByDeviceId: Array<string> | undefined, deviceId: string): boolean {
    return Array.isArray(excludedDevicesByDeviceId) && excludedDevicesByDeviceId.includes(deviceId);
  }

  private getPrivacyFriendlyConfig(config: PlatformConfig): object {
    return {
      ...config,
      clientId: StringUtils.mask(config.clientId),
      clientSecret: StringUtils.mask(config.clientSecret),
      daikinEmail: StringUtils.mask(config.daikinEmail),
      daikinPassword: config.daikinPassword ? '***' : undefined,
      excludedDevicesByDeviceId: config.excludedDevicesByDeviceId ? config.excludedDevicesByDeviceId.map((deviceId: string) => StringUtils.mask(deviceId)) : [],
    };
  }

  private onInvalidGrantError(tokenFilePath: string) {
    this.log.warn('[API Syncing] TokenSet is invalid, removing TokenSet file');
    try {
      fs.unlinkSync(tokenFilePath);
      this.log.warn('[API Syncing] TokenSet file removed. Please re-authenticate via the Homebridge UI.');
    } catch (e) {
      this.log.error('[API Syncing] TokenSet file could not be removed. Location:', tokenFilePath, e);
    }
  }

  /**
     * Handle WebSocket device updates by pushing updated values to HomeKit
     */
  private handleWebSocketDeviceUpdate(update: {
        deviceId: string;
        embeddedId: string;
        characteristicName: string;
        data: { value: unknown };
    }): void {
    // Find the accessory for this device
    const accessory = this.accessories.find(
      a => a.context.device.getId() === update.deviceId,
    );

    if (!accessory) {
      this.log.debug(`[WebSocket] No accessory found for device ${update.deviceId}`);
      return;
    }

    // Use the UpdateMapper to apply the update
    const result = this.updateMapper.applyUpdate(accessory, update);

    if (result.success) {
      this.log.debug(`[WebSocket] Updated ${result.updated.join(', ')}`);
    }
  }
}
