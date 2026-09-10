import { AuthManager } from "../auth/authManager.js";
import { LocalStore } from "../storage/localStore.js";
import { SessionStore } from "../storage/sessionStore.js";
import { addonRepository } from "../../data/repository/addonRepository.js";
import { ProfileManager } from "./profileManager.js";
import { ProfileSyncService } from "./profileSyncService.js";
import { LibrarySyncService } from "./librarySyncService.js";
import { WatchProgressSyncService } from "./watchProgressSyncService.js";
import { SavedLibrarySyncService } from "./savedLibrarySyncService.js";
import { WatchedItemsSyncService } from "./watchedItemsSyncService.js";
import { PluginSyncService } from "./pluginSyncService.js";
import { ProfileSettingsSyncService } from "./profileSettingsSyncService.js";
import { ProviderCredentialSyncService } from "./providerCredentialSyncService.js";
import { SimklSyncService } from "../../data/repository/simklSyncService.js";
import { CollectionSyncService } from "./collectionSyncService.js";
import { HomeCatalogSettingsSyncService } from "./homeCatalogSettingsSyncService.js";
import { ThemeManager } from "../../ui/theme/themeManager.js";
import { MemberAccessRepository } from "../../data/remote/supabase/memberAccessRepository.js";
import { I18n } from "../../i18n/index.js";
import { hasProfileSettingsCloudSyncPending } from "../../data/local/profileScopedStore.js";
import {
  getSyncBackoffRemainingMs,
  isSyncBackoffActive,
  resetSyncBackoff
} from "../sync/syncBackoffPolicy.js";

const FOREGROUND_ACTIVITY_PULL_DELAY_MS = 2500;
const FOREGROUND_ACTIVITY_PULL_MIN_INTERVAL_MS = 2 * 60 * 1000;
const PERIODIC_SURFACE_PULL_INTERVAL_MS = 15 * 60 * 1000;
const ADDON_PUSH_DEBOUNCE_MS = 500;
const MAX_PULL_ATTEMPTS = 3;
const FORCE_RESYNC_MIN_INTERVAL_MS = 30000;
const FULL_STARTUP_PULL_TTL_MS = 6 * 60 * 60 * 1000;
const STARTUP_SYNC_STATE_KEY = "startupSyncState";
const syncPullCompletedListeners = new Set();

function createAbortError() {
  const error = new Error("Startup sync aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    let timerId = 0;
    const onAbort = () => {
      if (timerId) clearTimeout(timerId);
      signal?.removeEventListener?.("abort", onAbort);
      reject(createAbortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timerId = setTimeout(
      () => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      },
      Math.max(0, Number(ms) || 0)
    );
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function normalizeProfileId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "1";
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = String(token || "").split(".");
    if (!payload || typeof atob !== "function") {
      return null;
    }
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch (_) {
    return null;
  }
}

function currentSyncKey(profileId = null) {
  const userId = String(decodeJwtPayload(SessionStore.accessToken)?.sub || "authenticated");
  return `${userId}:p${normalizeProfileId(profileId ?? ProfileManager.getActiveProfileId())}`;
}

function readStartupSyncState() {
  const value = LocalStore.get(STARTUP_SYNC_STATE_KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canUsePersistedWarmSync(key, includeProfileSettings, now = Date.now()) {
  const entry = readStartupSyncState()[key];
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const lastFullPullAtMs = Number(entry.lastFullPullAtMs || 0);
  return (
    lastFullPullAtMs > 0 &&
    now - lastFullPullAtMs < FULL_STARTUP_PULL_TTL_MS &&
    (!includeProfileSettings || entry.lastFullPullIncludedProfileSettings === true)
  );
}

function runSurface(label, task) {
  if (isSyncBackoffActive()) {
    return Promise.resolve({ ok: false, deferred: true });
  }
  return Promise.resolve()
    .then(task)
    .then((value) => ({ ok: true, value }))
    .catch((error) => {
      console.warn(`Startup sync ${label} failed; keeping local state`, error);
      return { ok: false, error };
    });
}

function notifySyncPullCompleted(event = {}) {
  syncPullCompletedListeners.forEach((listener) => {
    try {
      listener(event);
    } catch (error) {
      console.warn("Startup sync completion listener failed", error);
    }
  });
}

export const StartupSyncService = {
  started: false,
  intervalId: null,
  libraryIntervalId: null,
  foregroundPullTimer: null,
  foregroundPullPromise: null,
  lastForegroundPullKey: null,
  lastForegroundPullAtMs: 0,
  inFlight: false,
  inFlightPromise: null,
  inFlightGeneration: 0,
  watchStateInFlightPromise: null,
  watchStateInFlightGeneration: 0,
  libraryInFlightPromise: null,
  libraryInFlightGeneration: 0,
  addonPushPromise: null,
  profileScopedSyncEnabled: false,
  addonPushTimer: null,
  backoffRetryTimer: null,
  backoffRetryNotifyPullCompleted: false,
  unsubscribeAddonChanges: null,
  pendingSyncRequest: null,
  runGeneration: 0,
  lastPulledKey: null,
  lastPulledIncludedProfileSettings: false,
  lastPulledAtMs: 0,
  lastPullCompleted: false,

  isCurrentRun(generation) {
    return this.started && this.runGeneration === generation;
  },

  isCurrentProfile(profileId, key = currentSyncKey(profileId)) {
    return (
      key === currentSyncKey() && String(profileId) === String(ProfileManager.getActiveProfileId())
    );
  },

  isCurrentProfilePullPending() {
    return Boolean(
      this.started &&
      this.profileScopedSyncEnabled &&
      !(this.lastPullCompleted && this.lastPulledKey === currentSyncKey())
    );
  },

  scheduleBackoffRetry({ notifyPullCompleted = false } = {}) {
    if (!this.started || !AuthManager.isAuthenticated) {
      return;
    }
    const remainingMs = getSyncBackoffRemainingMs();
    if (remainingMs <= 0) {
      return;
    }
    this.backoffRetryNotifyPullCompleted = Boolean(
      this.backoffRetryNotifyPullCompleted || notifyPullCompleted
    );
    if (this.backoffRetryTimer) {
      return;
    }
    this.backoffRetryTimer = setTimeout(
      () => {
        this.backoffRetryTimer = null;
        const shouldNotifyPullCompleted = Boolean(this.backoffRetryNotifyPullCompleted);
        this.backoffRetryNotifyPullCompleted = false;
        void this.requestSyncNow({
          force: true,
          includeProfileSettings: true,
          notifyPullCompleted: shouldNotifyPullCompleted
        }).catch((error) => {
          console.warn("Scheduled startup sync retry failed", error);
        });
      },
      Math.max(1000, remainingMs + 50)
    );
  },

  queuePendingSyncRequest({
    force = true,
    includeProfileSettings = true,
    pushAfterPull = false,
    notifyPullCompleted = false
  }) {
    const current = this.pendingSyncRequest || {};
    this.pendingSyncRequest = {
      force: Boolean(current.force || force),
      includeProfileSettings: Boolean(current.includeProfileSettings || includeProfileSettings),
      pushAfterPull: Boolean(current.pushAfterPull || pushAfterPull),
      notifyPullCompleted: Boolean(current.notifyPullCompleted || notifyPullCompleted)
    };
  },

  markFullPullSucceeded(key, includeProfileSettings) {
    const now = Date.now();
    const previous = readStartupSyncState()[key] || {};
    const included = Boolean(
      includeProfileSettings || previous.lastFullPullIncludedProfileSettings === true
    );
    this.lastPulledKey = key;
    this.lastPulledIncludedProfileSettings = included;
    this.lastPulledAtMs = now;
    this.lastForegroundPullKey = key;
    this.lastForegroundPullAtMs = now;
    this.lastPullCompleted = true;
    LocalStore.set(STARTUP_SYNC_STATE_KEY, {
      ...readStartupSyncState(),
      [key]: {
        lastFullPullAtMs: now,
        lastFullPullIncludedProfileSettings: included
      }
    });
  },

  async start({ profileScopedSyncEnabled = false, runInitialPull = true } = {}) {
    if (this.started) {
      if (profileScopedSyncEnabled) {
        this.profileScopedSyncEnabled = true;
      }
      return;
    }
    this.started = true;
    this.runGeneration += 1;
    this.inFlight = false;
    this.profileScopedSyncEnabled = Boolean(profileScopedSyncEnabled);

    this.unsubscribeAddonChanges = addonRepository.onInstalledAddonsChanged(() => {
      this.scheduleAddonPush();
    });

    if (runInitialPull) {
      await this.requestSyncNow({ force: false, includeProfileSettings: true });
    }

    if (!this.started) {
      return;
    }
    this.intervalId = setInterval(() => {
      this.scheduleSurfacePull("periodic");
    }, PERIODIC_SURFACE_PULL_INTERVAL_MS);
  },

  stop({ waitForInFlight = false } = {}) {
    const pendingPromises = waitForInFlight
      ? [
          this.inFlightPromise,
          this.foregroundPullPromise,
          this.watchStateInFlightPromise,
          this.libraryInFlightPromise,
          this.addonPushPromise
        ].filter((promise) => promise && typeof promise.then === "function")
      : [];
    this.started = false;
    this.runGeneration += 1;
    this.profileScopedSyncEnabled = false;
    this.pendingSyncRequest = null;
    this.lastPulledKey = null;
    this.lastPulledIncludedProfileSettings = false;
    this.lastPulledAtMs = 0;
    this.lastPullCompleted = false;
    this.lastForegroundPullKey = null;
    this.lastForegroundPullAtMs = 0;
    if (this.foregroundPullTimer) {
      clearTimeout(this.foregroundPullTimer);
      this.foregroundPullTimer = null;
    }
    this.foregroundPullPromise = null;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.libraryIntervalId) {
      clearInterval(this.libraryIntervalId);
      this.libraryIntervalId = null;
    }
    if (this.addonPushTimer) {
      clearTimeout(this.addonPushTimer);
      this.addonPushTimer = null;
    }
    if (this.backoffRetryTimer) {
      clearTimeout(this.backoffRetryTimer);
      this.backoffRetryTimer = null;
    }
    this.backoffRetryNotifyPullCompleted = false;
    this.addonPushPromise = null;
    if (this.unsubscribeAddonChanges) {
      this.unsubscribeAddonChanges();
      this.unsubscribeAddonChanges = null;
    }
    resetSyncBackoff();
    if (!waitForInFlight || pendingPromises.length === 0) {
      return Promise.resolve(true);
    }
    return Promise.allSettled(pendingPromises).then(() => true);
  },

  enableProfileScopedSync() {
    this.profileScopedSyncEnabled = true;
  },

  ensurePluginServiceReady({ force = true } = {}) {
    return PluginSyncService.ensureReadyForPull({ force });
  },

  subscribeToPullCompleted(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    syncPullCompletedListeners.add(listener);
    return () => syncPullCompletedListeners.delete(listener);
  },

  scheduleSurfacePull(reason = "foreground", delayMs = 0, minIntervalMs = 0, force = false) {
    if (!this.started || !this.profileScopedSyncEnabled || !AuthManager.isAuthenticated) {
      return false;
    }
    const profileId = ProfileManager.getActiveProfileId();
    const key = currentSyncKey(profileId);
    const now = Date.now();
    if (this.inFlightPromise || this.foregroundPullTimer || this.foregroundPullPromise) {
      return false;
    }
    if (
      !force &&
      this.lastForegroundPullKey === key &&
      this.lastForegroundPullAtMs > 0 &&
      now >= this.lastForegroundPullAtMs &&
      now - this.lastForegroundPullAtMs < minIntervalMs
    ) {
      return false;
    }

    this.foregroundPullTimer = setTimeout(
      () => {
        this.foregroundPullTimer = null;
        if (!this.started || !this.profileScopedSyncEnabled || !AuthManager.isAuthenticated) {
          return;
        }
        if (this.inFlightPromise) {
          return;
        }
        let foregroundPullPromise = null;
        foregroundPullPromise = Promise.all([
          this.requestWatchStateSyncNow(),
          this.requestLibrarySyncNow()
        ])
          .then(([watchSucceeded, librarySucceeded]) => {
            if (watchSucceeded && librarySucceeded) {
              this.lastForegroundPullKey = key;
              this.lastForegroundPullAtMs = Date.now();
            }
            return Boolean(watchSucceeded && librarySucceeded);
          })
          .catch((error) => {
            console.warn(`Startup sync ${reason} surface pull failed`, error);
            return false;
          })
          .finally(() => {
            if (this.foregroundPullPromise === foregroundPullPromise) {
              this.foregroundPullPromise = null;
            }
          });
        this.foregroundPullPromise = foregroundPullPromise;
      },
      Math.max(0, Number(delayMs) || 0)
    );
    return true;
  },

  requestForegroundSync(force = false) {
    return this.scheduleSurfacePull(
      "foreground",
      force ? 0 : FOREGROUND_ACTIVITY_PULL_DELAY_MS,
      force ? 0 : FOREGROUND_ACTIVITY_PULL_MIN_INTERVAL_MS,
      force
    );
  },

  async requestSyncNow({
    force = true,
    includeProfileSettings = true,
    allowWarmRepeat = false,
    pushAfterPull = false,
    notifyPullCompleted = false
  } = {}) {
    if (!this.started) {
      return false;
    }
    const generation = this.runGeneration;
    if (this.inFlightPromise && this.inFlightGeneration === generation) {
      this.queuePendingSyncRequest({
        force,
        includeProfileSettings,
        pushAfterPull,
        notifyPullCompleted
      });
      return this.inFlightPromise;
    }
    if (!this.isCurrentRun(generation) || isSyncBackoffActive()) {
      this.scheduleBackoffRetry({ notifyPullCompleted });
      return false;
    }

    const profileId = ProfileManager.getActiveProfileId();
    const key = currentSyncKey(profileId);
    const now = Date.now();
    const coversProfileSettings =
      !includeProfileSettings || this.lastPulledIncludedProfileSettings === true;
    if (
      force &&
      this.lastPulledKey === key &&
      coversProfileSettings &&
      now - this.lastPulledAtMs < FORCE_RESYNC_MIN_INTERVAL_MS
    ) {
      if (notifyPullCompleted) {
        notifySyncPullCompleted({
          profileId: normalizeProfileId(profileId),
          includeProfileScoped: Boolean(this.profileScopedSyncEnabled),
          completedAt: Date.now()
        });
      }
      return true;
    }
    if (!force && !allowWarmRepeat && canUsePersistedWarmSync(key, includeProfileSettings, now)) {
      // Android's warm cycle runs the same broad remote pull as a cold
      // startup, including the plugin surface. Keep the service lazy while
      // preserving that timing and ordering instead of pulling plugins only.
      const warmPullSucceeded = await this.syncPull({
        includeProfileScoped: this.profileScopedSyncEnabled,
        includeProfileSettings,
        generation,
        profileId,
        key
      });
      if (warmPullSucceeded && this.isCurrentRun(generation) && !isSyncBackoffActive()) {
        this.markFullPullSucceeded(key, includeProfileSettings);
        this.lastPullCompleted = true;
        resetSyncBackoff();
        if (notifyPullCompleted) {
          notifySyncPullCompleted({
            profileId: normalizeProfileId(profileId),
            includeProfileScoped: Boolean(this.profileScopedSyncEnabled),
            completedAt: Date.now()
          });
        }
        return true;
      }
      this.lastPullCompleted = false;
      if (isSyncBackoffActive()) {
        this.scheduleBackoffRetry({ notifyPullCompleted });
      }
      return false;
    }

    let requestPromise = null;
    requestPromise = (async () => {
      this.inFlight = true;
      this.lastPullCompleted = false;
      let completed = false;
      try {
        for (let attempt = 1; attempt <= MAX_PULL_ATTEMPTS; attempt += 1) {
          if (!this.isCurrentRun(generation) || !AuthManager.isAuthenticated) {
            break;
          }
          if (!this.isCurrentProfile(profileId, key)) {
            break;
          }
          if (isSyncBackoffActive()) {
            this.scheduleBackoffRetry({ notifyPullCompleted });
            break;
          }

          const didComplete = await this.syncPull({
            includeProfileScoped: this.profileScopedSyncEnabled,
            includeProfileSettings,
            generation,
            profileId,
            key
          });
          if (didComplete && this.isCurrentRun(generation) && !isSyncBackoffActive()) {
            if (pushAfterPull && this.profileScopedSyncEnabled) {
              await this.syncPush({ generation, profileId, key });
            }
            if (!isSyncBackoffActive()) {
              this.markFullPullSucceeded(key, includeProfileSettings);
              resetSyncBackoff();
              completed = true;
              if (notifyPullCompleted) {
                notifySyncPullCompleted({
                  profileId: normalizeProfileId(profileId),
                  includeProfileScoped: Boolean(this.profileScopedSyncEnabled),
                  completedAt: Date.now()
                });
              }
              break;
            }
            this.scheduleBackoffRetry({ notifyPullCompleted });
            break;
          }
          if (isSyncBackoffActive()) {
            this.scheduleBackoffRetry({ notifyPullCompleted });
            break;
          }
          if (attempt < MAX_PULL_ATTEMPTS) {
            await sleep(3000, AuthManager.getSessionSignal?.());
          }
        }
        this.lastPullCompleted = completed;
        return completed;
      } finally {
        this.inFlight = false;
        if (this.inFlightPromise === requestPromise) {
          this.inFlightPromise = null;
          this.inFlightGeneration = 0;
        }
        const pending = this.pendingSyncRequest;
        this.pendingSyncRequest = null;
        if (pending && this.isCurrentRun(generation)) {
          setTimeout(() => {
            void this.requestSyncNow(pending).catch((error) => {
              console.warn("Queued startup sync failed", error);
            });
          }, 0);
        }
      }
    })();
    this.inFlightPromise = requestPromise;
    this.inFlightGeneration = generation;
    return requestPromise;
  },

  async syncPull({
    includeProfileScoped = this.profileScopedSyncEnabled,
    includeProfileSettings = true,
    generation = this.runGeneration,
    profileId = ProfileManager.getActiveProfileId(),
    key = currentSyncKey(profileId)
  } = {}) {
    if (
      !this.isCurrentRun(generation) ||
      !AuthManager.isAuthenticated ||
      !this.isCurrentProfile(profileId, key)
    ) {
      return false;
    }
    await ProfileSyncService.pull();
    if (!this.isCurrentProfile(profileId, key)) {
      return false;
    }
    const profileStatus = ProfileSyncService.getLastPullStatus?.();
    if (profileStatus === "deferred") {
      this.scheduleBackoffRetry();
      return false;
    }
    if (profileStatus === "error") {
      return false;
    }

    const activeProfileId = profileId;
    if (includeProfileSettings) {
      const profileSettingsResult = await runSurface("profile settings", async () => {
        const didApply = await ProfileSettingsSyncService.pull(activeProfileId);
        if (hasProfileSettingsCloudSyncPending(activeProfileId) && !isSyncBackoffActive()) {
          await ProfileSettingsSyncService.push(activeProfileId);
        }
        return didApply;
      });
      if (profileSettingsResult.ok && profileSettingsResult.value) {
        await runSurface("profile settings theme", async () => {
          await I18n.init();
          const memberAccess = await MemberAccessRepository.getAccess().catch(() =>
            MemberAccessRepository.getCurrentAccess()
          );
          ThemeManager.apply({ enforceAccess: true, access: memberAccess });
          I18n.apply();
        });
      }
    }

    await Promise.all([
      runSurface("provider credentials", () =>
        ProviderCredentialSyncService.syncFromRemote(activeProfileId)
      ),
      runSurface("Simkl refresh", () =>
        SimklSyncService.refresh().catch((error) => {
          console.warn("Simkl automatic refresh failed", error);
          return false;
        })
      )
    ]);

    if (!this.isCurrentProfile(profileId, key)) {
      return false;
    }

    if (!includeProfileScoped) {
      return this.isCurrentRun(generation) && !isSyncBackoffActive();
    }
    if (!this.isCurrentRun(generation) || isSyncBackoffActive()) {
      return false;
    }

    await Promise.all([
      // Android pulls plugins and addons as independent surfaces. Keep a
      // plugin-service/readiness failure from suppressing the addon snapshot.
      runSurface("plugins", () => PluginSyncService.pull(activeProfileId)),
      runSurface("collections", () => CollectionSyncService.pull(activeProfileId)),
      runSurface("home catalog settings", () =>
        HomeCatalogSettingsSyncService.pull(activeProfileId)
      ),
      runSurface("addons", () => LibrarySyncService.pull()),
      runSurface("saved library", () => SavedLibrarySyncService.pull(activeProfileId))
    ]);

    if (!this.isCurrentRun(generation) || isSyncBackoffActive()) {
      return false;
    }
    await runSurface("watched items", () => WatchedItemsSyncService.pull(activeProfileId));
    if (!this.isCurrentRun(generation) || isSyncBackoffActive()) {
      return false;
    }
    await runSurface("watch progress", () => WatchProgressSyncService.pull(activeProfileId));
    return this.isCurrentRun(generation) && !isSyncBackoffActive();
  },

  async requestWatchStateSyncNow() {
    if (!this.started || !this.profileScopedSyncEnabled || !AuthManager.isAuthenticated) {
      return false;
    }
    const generation = this.runGeneration;
    const profileId = ProfileManager.getActiveProfileId();
    const profileKey = currentSyncKey(profileId);
    if (this.watchStateInFlightPromise && this.watchStateInFlightGeneration === generation) {
      return this.watchStateInFlightPromise;
    }
    if (isSyncBackoffActive()) {
      this.scheduleBackoffRetry();
      return false;
    }

    let requestPromise = null;
    requestPromise = (async () => {
      try {
        if (!this.isCurrentProfile(profileId, profileKey)) {
          return false;
        }
        const watchedResult = await runSurface("periodic watched items", () =>
          WatchedItemsSyncService.pull(profileId)
        );
        if (!watchedResult.ok) {
          return false;
        }
        if (
          watchedResult.ok &&
          WatchedItemsSyncService.getLastPullHadUnsynced?.() &&
          !isSyncBackoffActive()
        ) {
          await runSurface("periodic watched items push", () =>
            WatchedItemsSyncService.push(profileId)
          );
        }
        if (!isSyncBackoffActive()) {
          if (!this.isCurrentProfile(profileId, profileKey)) {
            return false;
          }
          const progressResult = await runSurface("periodic watch progress", () =>
            WatchProgressSyncService.pull(profileId)
          );
          if (!progressResult.ok) {
            return false;
          }
          if (
            progressResult.ok &&
            WatchProgressSyncService.getLastPullHadUnsynced?.() &&
            !isSyncBackoffActive()
          ) {
            await runSurface("periodic watch progress push", () =>
              WatchProgressSyncService.push(profileId)
            );
          }
        }
        if (isSyncBackoffActive()) {
          this.scheduleBackoffRetry();
          return false;
        }
        return this.isCurrentRun(generation) && this.isCurrentProfile(profileId, profileKey);
      } finally {
        if (this.watchStateInFlightPromise === requestPromise) {
          this.watchStateInFlightPromise = null;
          this.watchStateInFlightGeneration = 0;
        }
      }
    })();
    this.watchStateInFlightPromise = requestPromise;
    this.watchStateInFlightGeneration = generation;
    return requestPromise;
  },

  async requestLibrarySyncNow() {
    if (!this.started || !this.profileScopedSyncEnabled || !AuthManager.isAuthenticated) {
      return false;
    }
    const generation = this.runGeneration;
    const profileId = ProfileManager.getActiveProfileId();
    const profileKey = currentSyncKey(profileId);
    if (this.libraryInFlightPromise && this.libraryInFlightGeneration === generation) {
      return this.libraryInFlightPromise;
    }
    if (isSyncBackoffActive()) {
      this.scheduleBackoffRetry();
      return false;
    }

    let requestPromise = null;
    requestPromise = (async () => {
      try {
        if (!this.isCurrentProfile(profileId, profileKey)) {
          return false;
        }
        // Android's foreground/periodic activity cycle refreshes the Nuvio
        // library, but addon/plugin repositories are refreshed by the full
        // startup pull or by their explicit/manual sync path.
        const savedLibraryResult = await runSurface("periodic saved library", () =>
          SavedLibrarySyncService.pull(profileId)
        );
        if (!savedLibraryResult.ok) {
          return false;
        }
        if (isSyncBackoffActive()) {
          this.scheduleBackoffRetry();
          return false;
        }
        return this.isCurrentRun(generation) && this.isCurrentProfile(profileId, profileKey);
      } finally {
        if (this.libraryInFlightPromise === requestPromise) {
          this.libraryInFlightPromise = null;
          this.libraryInFlightGeneration = 0;
        }
      }
    })();
    this.libraryInFlightPromise = requestPromise;
    this.libraryInFlightGeneration = generation;
    return requestPromise;
  },

  async syncPush({
    generation = this.runGeneration,
    profileId = ProfileManager.getActiveProfileId(),
    key = currentSyncKey(profileId)
  } = {}) {
    if (
      !this.isCurrentRun(generation) ||
      !AuthManager.isAuthenticated ||
      isSyncBackoffActive() ||
      !this.isCurrentProfile(profileId, key)
    ) {
      this.scheduleBackoffRetry();
      return false;
    }
    const surfaces = [
      ["profiles push", () => ProfileSyncService.push()],
      ["profile settings push", () => ProfileSettingsSyncService.push()],
      ["collections push", () => CollectionSyncService.push()],
      ["home catalog settings push", () => HomeCatalogSettingsSyncService.push()],
      ["plugins push", () => PluginSyncService.push(profileId)],
      ["addons push", () => LibrarySyncService.push()],
      ["saved library push", () => SavedLibrarySyncService.push(profileId)],
      ["watched items push", () => WatchedItemsSyncService.push(profileId)],
      ["watch progress push", () => WatchProgressSyncService.push(profileId)]
    ];
    for (const [label, task] of surfaces) {
      if (
        !this.isCurrentRun(generation) ||
        isSyncBackoffActive() ||
        !this.isCurrentProfile(profileId, key)
      ) {
        this.scheduleBackoffRetry();
        return false;
      }
      await runSurface(label, task);
    }
    return !isSyncBackoffActive();
  },

  async syncCycle() {
    return this.requestWatchStateSyncNow();
  },

  scheduleAddonPush(delayMs = ADDON_PUSH_DEBOUNCE_MS) {
    if (!this.started || !this.profileScopedSyncEnabled) {
      return;
    }
    if (this.addonPushTimer) {
      clearTimeout(this.addonPushTimer);
    }
    const cooldownMs = getSyncBackoffRemainingMs();
    const effectiveDelayMs = Math.max(
      ADDON_PUSH_DEBOUNCE_MS,
      Number(delayMs) || 0,
      cooldownMs > 0 ? cooldownMs + 50 : 0
    );
    this.addonPushTimer = setTimeout(() => {
      this.addonPushTimer = null;
      let pushPromise = null;
      pushPromise = Promise.resolve()
        .then(async () => {
          if (!AuthManager.isAuthenticated) {
            return false;
          }
          if (isSyncBackoffActive()) {
            this.scheduleAddonPush();
            return false;
          }
          const didPush = await LibrarySyncService.push();
          if (!didPush && isSyncBackoffActive()) {
            this.scheduleAddonPush();
          }
          return didPush;
        })
        .catch((error) => {
          console.warn("Addon push failed", error);
          return false;
        })
        .finally(() => {
          if (this.addonPushPromise === pushPromise) {
            this.addonPushPromise = null;
          }
        });
      this.addonPushPromise = pushPromise;
    }, effectiveDelayMs);
  }
};

AuthManager.registerSessionTeardownListener?.(() =>
  StartupSyncService.stop({ waitForInFlight: true })
);
