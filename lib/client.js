window.__ModuleLoader__.load({
	id: "dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/locales.ts
		/**
		* Notification copy. Product-visible text lives in the locale registry rather
		* than at the call site, so the plugin follows the application language.
		*/
		/** Locale namespace this plugin owns. */
		const NS = "dsh-notify";
		/** Chinese copy. */
		const zh = {
			"notification.title": "DeepSeek Harness",
			"notification.turnEnd": "「{title}」已完成",
			"notification.agentError": "「{title}」本轮运行失败",
			"notification.pendingInteraction": "「{title}」在等待你的确认",
			"notification.jobCompleted": "后台任务完成：{label}",
			"notification.jobFailed": "后台任务失败：{label}",
			"notification.jobKilled": "后台任务已取消：{label}",
			"notification.sessionFallback": "当前会话",
			"notification.selfTest": "通知已接通：任务结束、出错、后台任务结束或需要你确认时，都会像这样提醒你。"
		};
		/** English copy. */
		const en = {
			"notification.title": "DeepSeek Harness",
			"notification.turnEnd": "\"{title}\" finished",
			"notification.agentError": "\"{title}\" failed this turn",
			"notification.pendingInteraction": "\"{title}\" is waiting for your confirmation",
			"notification.jobCompleted": "Background job finished: {label}",
			"notification.jobFailed": "Background job failed: {label}",
			"notification.jobKilled": "Background job cancelled: {label}",
			"notification.sessionFallback": "Current session",
			"notification.selfTest": "Notifications are live: turns, errors, background jobs and confirmations will arrive like this."
		};
		//#endregion
		//#region src/client/triggers.ts
		/** Whether a job status is terminal. */
		function isSettled(status) {
			return status === "completed" || status === "failed" || status === "killed";
		}
		/** Fold client-observed facts into notifications. */
		var TriggerEngine = class {
			options;
			/** Wall-clock start of the run currently in flight, per session. */
			runStartedAt = /* @__PURE__ */ new Map();
			/** Turn-end notices waiting out {@link TriggerOptions.replaceTurnEndMs}. */
			deferred = /* @__PURE__ */ new Map();
			/** Sessions whose in-flight run already reported an error. */
			errored = /* @__PURE__ */ new Set();
			/** Until this instant, a turn-end for the session is replaced by a better notice. */
			replaceUntil = /* @__PURE__ */ new Map();
			/** Settled-job identities already reported, so a reappearing row stays silent. */
			notifiedJobs = /* @__PURE__ */ new Set();
			/** Last observed status per session and job id. */
			seenJobs = /* @__PURE__ */ new Map();
			jobsBaselined = false;
			/** Pending-interaction identities already observed, keyed by session and domain key. */
			seenPending = /* @__PURE__ */ new Set();
			pendingBaselined = false;
			/** @param options - clock and thresholds. */
			constructor(options) {
				this.options = options;
			}
			/**
			* Fold one agent running-state change.
			* @param sessionId - session whose agent changed state.
			* @param running - current agent running state.
			* @returns notices to show now; a qualifying turn end is deferred instead.
			*/
			onAgentStatus(sessionId, running) {
				if (running) {
					this.runStartedAt.set(sessionId, this.options.now());
					this.errored.delete(sessionId);
					this.replaceUntil.delete(sessionId);
					return [];
				}
				const startedAt = this.runStartedAt.get(sessionId);
				this.runStartedAt.delete(sessionId);
				if (startedAt === void 0) return [];
				const now = this.options.now();
				if (now - startedAt < this.options.minRunMs) return [];
				if (this.errored.delete(sessionId)) return [];
				const replaceUntil = this.replaceUntil.get(sessionId);
				if (replaceUntil !== void 0 && now <= replaceUntil) return [];
				this.deferred.set(sessionId, {
					notice: {
						kind: "turn-end",
						sessionId
					},
					dueAt: now + this.options.replaceTurnEndMs
				});
				return [];
			}
			/**
			* Fold one agent error report.
			* @param sessionId - session whose run failed.
			* @param message - agent error text.
			* @returns the error notice; a deferred turn-end for the same run is dropped.
			*/
			onAgentError(sessionId, message) {
				const now = this.options.now();
				this.errored.add(sessionId);
				this.replaceUntil.set(sessionId, now + this.options.replaceTurnEndMs);
				this.deferred.delete(sessionId);
				return [{
					kind: "agent-error",
					sessionId,
					detail: message
				}];
			}
			/**
			* Fold one background-job mirror snapshot.
			* @param snapshot - visible jobs per session, as the client list mirror publishes them.
			* A missing mirror reads as empty: the list store publishes states without one,
			* and a notification rule must never throw into its store subscriber.
			* @returns one notice per job that settled since the previous snapshot.
			*/
			onJobs(snapshot) {
				const mirror = snapshot ?? {};
				const notices = [];
				const next = /* @__PURE__ */ new Map();
				for (const sessionId of Object.keys(mirror)) {
					const byId = /* @__PURE__ */ new Map();
					for (const row of mirror[sessionId] ?? []) {
						byId.set(row.id, row.status);
						if (!this.jobsBaselined) continue;
						if (!isSettled(row.status) || this.seenJobs.get(sessionId)?.get(row.id) === row.status) continue;
						const identity = `${sessionId}\u0000${row.id}\u0000${row.status}`;
						if (this.notifiedJobs.has(identity)) continue;
						this.notifiedJobs.add(identity);
						notices.push({
							kind: "job-settled",
							sessionId,
							detail: row.label,
							jobStatus: row.status
						});
					}
					next.set(sessionId, byId);
				}
				this.seenJobs.clear();
				for (const [sessionId, byId] of next) this.seenJobs.set(sessionId, byId);
				this.jobsBaselined = true;
				return notices;
			}
			/**
			* Fold one pending-interaction snapshot.
			* @param snapshot - the effective pending interaction per session, when one exists.
			* @returns one notice per interaction that appeared since the previous snapshot.
			*/
			onPendingInteractions(snapshot) {
				const notices = [];
				const seen = /* @__PURE__ */ new Set();
				const now = this.options.now();
				for (const [sessionId, interaction] of snapshot) {
					if (interaction === void 0) continue;
					const identity = `${sessionId}\u0000${interaction.key}`;
					seen.add(identity);
					if (!this.pendingBaselined || this.seenPending.has(identity)) continue;
					notices.push({
						kind: "pending-interaction",
						sessionId
					});
					this.replaceUntil.set(sessionId, now + this.options.replaceTurnEndMs);
					this.deferred.delete(sessionId);
				}
				this.seenPending.clear();
				for (const identity of seen) this.seenPending.add(identity);
				this.pendingBaselined = true;
				return notices;
			}
			/**
			* Take turn-end notices whose deferral has elapsed.
			* @returns notices that are due at the current clock reading.
			*/
			due() {
				const now = this.options.now();
				const notices = [];
				for (const [sessionId, entry] of [...this.deferred]) {
					if (entry.dueAt > now) continue;
					this.deferred.delete(sessionId);
					notices.push(entry.notice);
				}
				return notices;
			}
			/**
			* Earliest deferral deadline.
			* @returns the deadline in wall-clock milliseconds, or undefined when no turn end waits.
			*/
			nextDueAt() {
				let earliest;
				for (const entry of this.deferred.values()) if (earliest === void 0 || entry.dueAt < earliest) earliest = entry.dueAt;
				return earliest;
			}
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of `dsh-notify`.
		*
		* The plugin raises operating-system notifications for the four moments a DSH
		* user needs to look away from the window and come back: a turn finished, a
		* turn failed, a background job settled, and an agent that is waiting for
		* confirmation. Notifications are rendered by the browser's own notification
		* platform, so they land in the Windows Action Center, macOS Notification
		* Center, or the Linux notification daemon, and the plugin works in both the
		* desktop shell and a plain browser window.
		*/
		/** Plugin name. */
		const name = "dsh-notify";
		/** Client services the notification rules read. */
		const inject = [
			"remote",
			"sessions",
			"locale"
		];
		const DEFAULT_OPTIONS = {
			onlyWhenUnfocused: true,
			minRunMs: 1e4,
			silent: false,
			selfTest: true,
			replaceTurnEndMs: 2e3
		};
		const OPTIONS_KEY = "dsh-notify.options";
		const SELF_TEST_KEY = "dsh-notify.selfTestShown";
		/** Closed-union exhaustiveness fence. */
		function assertNever(value) {
			throw new Error(`dsh-notify: unhandled notice kind ${JSON.stringify(value)}`);
		}
		/** Notification body for one notice. */
		function bodyFor(notice, sessionTitle, t) {
			switch (notice.kind) {
				case "turn-end": return t("notification.turnEnd", { title: sessionTitle });
				case "agent-error": return t("notification.agentError", { title: sessionTitle });
				case "pending-interaction": return t("notification.pendingInteraction", { title: sessionTitle });
				case "job-settled": {
					const label = notice.detail ?? sessionTitle;
					if (notice.jobStatus === "failed") return t("notification.jobFailed", { label });
					if (notice.jobStatus === "killed") return t("notification.jobKilled", { label });
					return t("notification.jobCompleted", { label });
				}
				default: return assertNever(notice.kind);
			}
		}
		/**
		* Read one stored value.
		* @param key - storage key.
		* @returns the stored string, or null when absent or storage is unavailable.
		*/
		function readStored(key) {
			try {
				return globalThis.localStorage?.getItem(key) ?? null;
			} catch {
				return null;
			}
		}
		/**
		* Store one value, best effort.
		* @param key - storage key.
		* @param value - value to store.
		*/
		function writeStored(key, value) {
			try {
				globalThis.localStorage?.setItem(key, value);
			} catch {}
		}
		/** Narrow one unknown override to a boolean. */
		function booleanOr(value, fallback) {
			return typeof value === "boolean" ? value : fallback;
		}
		/** Milliseconds between polls of the pending-interaction map on clients that publish no observable. */
		const PENDING_POLL_MS = 1e3;
		/**
		* Normalize one pending-interaction value into an engine row.
		* @param value - domain-owned pending value.
		* @returns a row carrying a stable identity.
		*/
		function normalizePendingRow(value) {
			const record = value ?? {};
			return { key: typeof record.key === "string" ? record.key : String(record.kind ?? "pending") };
		}
		/**
		* Normalize a pending-interaction snapshot.
		* @param snapshot - session-keyed pending values, as a Map or a plain record.
		* @returns the rule engine's read view.
		*/
		function normalizePending(snapshot) {
			const source = snapshot instanceof Map ? [...snapshot.entries()] : Object.entries(snapshot ?? {});
			const normalized = /* @__PURE__ */ new Map();
			for (const [sessionId, value] of source) {
				if (value === void 0 || value === null) continue;
				normalized.set(String(sessionId), normalizePendingRow(value));
			}
			return normalized;
		}
		/** Narrow one unknown override to a finite, non-negative number. */
		function numberOr(value, fallback) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
		}
		/**
		* Resolve the runtime tunables.
		* @returns stored overrides merged over {@link DEFAULT_OPTIONS}.
		*/
		function readOptions() {
			const raw = readStored(OPTIONS_KEY);
			if (raw === null) return DEFAULT_OPTIONS;
			try {
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return DEFAULT_OPTIONS;
				const record = parsed;
				return {
					onlyWhenUnfocused: booleanOr(record.onlyWhenUnfocused, DEFAULT_OPTIONS.onlyWhenUnfocused),
					minRunMs: numberOr(record.minRunMs, DEFAULT_OPTIONS.minRunMs),
					silent: booleanOr(record.silent, DEFAULT_OPTIONS.silent),
					selfTest: booleanOr(record.selfTest, DEFAULT_OPTIONS.selfTest),
					replaceTurnEndMs: numberOr(record.replaceTurnEndMs, DEFAULT_OPTIONS.replaceTurnEndMs)
				};
			} catch (error) {
				console.warn("[dsh-notify] ignoring malformed options override", error);
				return DEFAULT_OPTIONS;
			}
		}
		/**
		* Install the notification rules.
		*
		* The whole activation is contained: a client entry that throws fails the Web
		* boot audit, and the desktop shell treats that audit failure as fatal. A
		* notification plugin must degrade to "off" rather than take the application
		* down with it.
		* @param ctx - client context.
		*/
		function apply(ctx) {
			try {
				activate(ctx);
			} catch (error) {
				console.error("[dsh-notify] activation failed; notifications stay off", error);
			}
		}
		/**
		* Wire the notification rules onto the client services.
		* @param ctx - client context.
		*/
		function activate(ctx) {
			const Ctor = globalThis.Notification;
			if (Ctor === void 0) {
				console.warn("[dsh-notify] this environment has no Web Notification API; notifications stay off");
				return;
			}
			const options = readOptions();
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-notify: dictionaries");
			const t = ctx.locale.bind(NS);
			const remote = ctx.remote;
			const sessions = ctx.sessions;
			const list = sessions.list;
			const engine = new TriggerEngine({
				minRunMs: options.minRunMs,
				replaceTurnEndMs: options.replaceTurnEndMs,
				now: () => Date.now()
			});
			/** Display title of one session, from the client list mirror. */
			const sessionTitle = (sessionId) => {
				return (list.getSnapshot().byId?.[sessionId])?.displayTitle ?? t("notification.sessionFallback");
			};
			/** Show one notification. */
			const show = (notice) => {
				if (Ctor.permission !== "granted") return;
				if (options.onlyWhenUnfocused && document.visibilityState === "visible" && document.hasFocus()) return;
				try {
					const notification = new Ctor(t("notification.title"), {
						body: bodyFor(notice, sessionTitle(notice.sessionId), t),
						silent: options.silent
					});
					notification.onclick = () => {
						try {
							window.focus();
						} catch {}
						try {
							sessions.open?.(notice.sessionId);
						} catch {}
					};
				} catch (error) {
					console.warn("[dsh-notify] could not show notification", error);
				}
			};
			let timer;
			/** Show every notice just produced, then arm the deferral timer. */
			const pump = (notices) => {
				for (const notice of notices) show(notice);
				if (timer !== void 0) clearTimeout(timer);
				for (const notice of engine.due()) show(notice);
				const dueAt = engine.nextDueAt();
				timer = dueAt === void 0 ? void 0 : setTimeout(() => {
					pump([]);
				}, Math.max(0, dueAt - Date.now()));
			};
			ctx.effect(() => () => {
				if (timer !== void 0) clearTimeout(timer);
			}, "dsh-notify: deferral timer");
			ctx.effect(() => {
				const uiSession = ctx.get("uiSession");
				const disposers = [
					remote.$on("api-session/status", (sessionId, running) => {
						pump(engine.onAgentStatus(sessionId, running));
					}),
					remote.$on("api-session/error", (sessionId, message) => {
						pump(engine.onAgentError(sessionId, message));
					}),
					list.subscribe(() => {
						pump(engine.onJobs(list.getSnapshot().jobsBySession));
					})
				];
				engine.onJobs(list.getSnapshot().jobsBySession);
				for (const [sessionId, row] of Object.entries(list.getSnapshot().byId ?? {})) if (row?.running === true) engine.onAgentStatus(sessionId, true);
				const pending = uiSession?.pendingInteractions;
				if (pending !== void 0) {
					disposers.push(pending.subscribe(() => {
						pump(engine.onPendingInteractions(normalizePending(pending.getSnapshot())));
					}));
					engine.onPendingInteractions(normalizePending(pending.getSnapshot()));
				} else if (uiSession !== void 0) {
					const read = () => normalizePending(uiSession.pendingSnapshot);
					engine.onPendingInteractions(read());
					const interval = setInterval(() => {
						pump(engine.onPendingInteractions(read()));
					}, PENDING_POLL_MS);
					disposers.push(() => {
						clearInterval(interval);
					});
				}
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, "dsh-notify: client subscriptions");
			/**
			* Show the one-time installation notification, once the platform allows it.
			* The desktop shell may report `default` until a permission request resolves,
			* so this also runs after the first granted request.
			*/
			const maybeSelfTest = () => {
				if (!options.selfTest || Ctor.permission !== "granted" || readStored(SELF_TEST_KEY) === "1") return;
				try {
					new Ctor(t("notification.title"), {
						body: t("notification.selfTest"),
						silent: options.silent
					});
					writeStored(SELF_TEST_KEY, "1");
				} catch (error) {
					console.warn("[dsh-notify] self-test notification failed", error);
				}
			};
			if (Ctor.permission === "default") ctx.effect(() => {
				const request = () => {
					window.removeEventListener("pointerdown", request);
					window.removeEventListener("keydown", request);
					Ctor.requestPermission().then(maybeSelfTest, () => {});
				};
				window.addEventListener("pointerdown", request, { once: true });
				window.addEventListener("keydown", request, { once: true });
				return () => {
					window.removeEventListener("pointerdown", request);
					window.removeEventListener("keydown", request);
				};
			}, "dsh-notify: permission request");
			maybeSelfTest();
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map