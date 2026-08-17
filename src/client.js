// dsh-deepseek-usage — browser half.
//
// A floating card pinned to the bottom-right corner of the dsh web GUI,
// registered into the frame-wide `shell.overlay` slot (additive, above every
// column; the layer is click-through until the card opts back into pointer
// events). It polls three loopback host routes:
//
//   /api/dsh-deepseek-usage/balance        remaining balance (60s)
//   /api/dsh-deepseek-usage/today          today's consumption (60s)
//   /api/dsh-deepseek-usage/session-cost   current conversation cost (5s)
//
// Styling uses only `--dsw-*` theme tokens, so the card follows light/dark
// mode. The API key / platform token never leave the machine: the browser
// only talks to the local routes the host half registers.
//
// This file is a hand-written client bundle in the dsh.client format:
// `window.__ModuleLoader__.load({ id, factory })` with a CJS-style factory.
// No build step required.
window.__ModuleLoader__.load({
	id: "dsh-deepseek-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		// ---- constants ---------------------------------------------------
		const BALANCE_PATH = "/api/dsh-deepseek-usage/balance";
		const TODAY_PATH = "/api/dsh-deepseek-usage/today";
		const SESSION_PATH = "/api/dsh-deepseek-usage/session-cost";
		const BALANCE_POLL_MS = 60 * 1000;
		const SESSION_POLL_MS = 5 * 1000;

		// ---- small helpers -----------------------------------------------
		function currencySymbol(code) {
			switch (code) {
				case "CNY": return "¥";
				case "USD": return "$";
				case "EUR": return "€";
				case "JPY": return "¥";
				case "HKD": return "HK$";
				default: return code ? `${code} ` : "";
			}
		}

		function formatMoney(value, currency) {
			const symbol = currencySymbol(currency);
			if (!Number.isFinite(value)) return `${symbol}—`;
			if (value === 0) return `${symbol}0`;
			if (value >= 100) return `${symbol}${value.toFixed(0)}`;
			if (value >= 1) return `${symbol}${value.toFixed(2)}`;
			if (value >= 0.01) return `${symbol}${value.toFixed(3)}`;
			return `${symbol}${value.toPrecision(2)}`;
		}

		function formatTokens(value) {
			return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		function formatRate(rate) {
			const n = rate >= 1 ? rate.toFixed(2) : rate.toFixed(3);
			return `¥${n}/M`;
		}

		function formatTime(date) {
			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			const ss = String(date.getSeconds()).padStart(2, "0");
			return `${hh}:${mm}:${ss}`;
		}

		async function getJson(path) {
			const res = await fetch(path, { cache: "no-store" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok) {
				const error = new Error(body && typeof body.message === "string" ? body.message : `请求失败（HTTP ${res.status}）`);
				error.code = body && typeof body.error === "string" ? body.error : `http-${res.status}`;
				throw error;
			}
			return body;
		}

		// ---- inline styles -----------------------------------------------
		const card = {
			position: "absolute",
			right: 16,
			bottom: 16,
			zIndex: 30,
			pointerEvents: "auto",
			boxSizing: "border-box",
			width: 250,
			borderRadius: 12,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 4px 16px rgba(0, 0, 0, 0.16)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			padding: "8px 10px",
			display: "flex",
			flexDirection: "column",
			gap: 2
		};

		const headerRow = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			height: 20
		};

		const title = {
			flex: 1,
			minWidth: 0,
			display: "flex",
			alignItems: "center",
			gap: 6,
			fontWeight: 600,
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const refreshButton = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 20,
			height: 20,
			border: 0,
			borderRadius: 6,
			padding: 0,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer"
		};

		const balanceRow = {
			display: "flex",
			alignItems: "baseline",
			gap: 6
		};

		const balanceValue = {
			fontSize: 20,
			lineHeight: "26px",
			fontWeight: 700,
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};

		const statusChip = {
			flex: "none",
			borderRadius: 999,
			padding: "0 6px",
			fontSize: 10,
			lineHeight: "16px"
		};

		const infoRow = {
			display: "flex",
			alignItems: "center",
			gap: 4,
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 11,
			lineHeight: "16px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const convCostRow = {
			display: "flex",
			alignItems: "center",
			gap: 4,
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			fontWeight: 600,
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};

		const convCostLabel = {
			color: "var(--dsw-alias-label-secondary)",
			fontWeight: 400
		};

		const infoIcon = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 14,
			height: 14,
			borderRadius: "50%",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "help",
			verticalAlign: "middle"
		};

		const tipBox = {
			position: "absolute",
			bottom: "calc(100% + 8px)",
			right: 0,
			zIndex: 40,
			boxSizing: "border-box",
			width: 320,
			borderRadius: 10,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
			padding: "8px 10px",
			fontSize: 11,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-primary)",
			display: "flex",
			flexDirection: "column",
			gap: 2
		};

		const tipTitle = {
			fontWeight: 600,
			fontSize: 12,
			lineHeight: "18px",
			marginBottom: 2,
			fontVariantNumeric: "tabular-nums"
		};

		const tipRow = {
			display: "flex",
			alignItems: "baseline",
			justifyContent: "space-between",
			gap: 8,
			fontVariantNumeric: "tabular-nums"
		};

		const tipLabel = {
			color: "var(--dsw-alias-label-secondary)",
			flex: "none",
			whiteSpace: "nowrap"
		};

		const tipFormula = {
			color: "var(--dsw-alias-label-primary)",
			textAlign: "right",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const tipFooter = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 10,
			lineHeight: "16px",
			marginTop: 2,
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			paddingTop: 4,
			fontVariantNumeric: "tabular-nums"
		};

		const metaRow = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 11,
			lineHeight: "16px",
			whiteSpace: "nowrap",
			overflow: "hidden"
		};

		const metaItem = {
			display: "flex",
			alignItems: "center",
			gap: 4,
			fontVariantNumeric: "tabular-nums",
			minWidth: 0,
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const updatedRow = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 10,
			lineHeight: "14px",
			display: "flex",
			alignItems: "center",
			gap: 4,
			fontVariantNumeric: "tabular-nums"
		};

		const errorText = {
			color: "var(--dsw-alias-state-error-primary)",
			fontSize: 11,
			lineHeight: "16px",
			wordBreak: "break-all"
		};

		const loadingText = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: "18px"
		};

		// ---- the widget ---------------------------------------------------
		function DeepSeekUsageCard(props) {
			const useSessions = props.useSessions;
			const [balance, setBalance] = useState(null);
			const [today, setToday] = useState(null);
			const [conversation, setConversation] = useState(null);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const [message, setMessage] = useState("");
			const [updatedAt, setUpdatedAt] = useState(null);
			const [spinning, setSpinning] = useState(false);
			const [tipOpen, setTipOpen] = useState(false);
			const mounted = useRef(true);

			// Current session id (SessionListState.current, injected standard share).
			const currentSessionId = typeof useSessions === "function" ? useSessions((s) => s.current) : void 0;

			// Current conversation cost: host replays the session log and prices
			// it at the official table — 5s poll, local route, negligible cost.
			useEffect(() => {
				if (currentSessionId === void 0) {
					setConversation(null);
					return;
				}
				let cancelled = false;
				const loadCost = async () => {
					try {
						const body = await getJson(`${SESSION_PATH}?sessionId=${encodeURIComponent(currentSessionId)}`);
						if (cancelled || body === null || typeof body !== "object" || body.ok !== true) return;
						setConversation(body);
					} catch {}
				};
				loadCost();
				const timer = setInterval(loadCost, SESSION_POLL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [currentSessionId]);

			// Balance + today's consumption, 60s each.
			const load = useCallback(async () => {
				setSpinning(true);
				try {
					const [balanceBody, todayBody] = await Promise.all([
						getJson(BALANCE_PATH),
						getJson(TODAY_PATH)
					]);
					if (!mounted.current) return;
					setBalance(balanceBody);
					setToday(todayBody);
					setPhase("ready");
					setMessage("");
					setUpdatedAt(new Date());
				} catch (error) {
					if (!mounted.current) return;
					setPhase("error");
					setMessage(error instanceof Error ? error.message : String(error));
				} finally {
					if (mounted.current) setSpinning(false);
				}
			}, []);

			useEffect(() => {
				mounted.current = true;
				load();
				const timer = setInterval(load, BALANCE_POLL_MS);
				return () => {
					mounted.current = false;
					clearInterval(timer);
				};
			}, [load]);

			// ---- derived view state ----
			const balanceInfo = balance && balance.ok === true && Array.isArray(balance.balance_infos)
				? balance.balance_infos[0]
				: null;
			const available = balance ? balance.is_available !== false : null;
			const currency = balanceInfo ? balanceInfo.currency : "CNY";

			const todayCost = today && today.ok === true && typeof today.cost === "number" ? today.cost : null;
			const todaySource = today && today.ok === true ? today.source : null;

			const conversationCost = conversation && typeof conversation.cost === "number" ? conversation.cost : null;
			const breakdown = conversation && Array.isArray(conversation.breakdown) ? conversation.breakdown : null;
			const formulaLines = breakdown ? breakdown.filter((b) => b !== null && typeof b === "object" && b.tokens > 0) : [];

			const stateColor = phase === "error"
				? "var(--dsw-alias-state-error-primary)"
				: available === false
					? "var(--dsw-alias-state-error-primary)"
					: "var(--dsw-alias-state-success-primary)";

			let chip = null;
			if (phase === "ready") {
				chip = jsx("span", {
					style: {
						...statusChip,
						color: stateColor,
						background: "var(--dsw-alias-interactive-bg-hover)"
					},
					children: available === false ? "不可用" : "可用"
				});
			} else if (phase === "error") {
				chip = jsx("span", {
					style: { ...statusChip, color: stateColor },
					children: "错误"
				});
			}

			const dot = jsx("span", {
				style: {
					flex: "none",
					width: 8,
					height: 8,
					borderRadius: "50%",
					background: phase === "loading" ? "var(--dsw-alias-label-secondary)" : stateColor
				},
				"aria-hidden": true
			});

			const refreshIcon = jsx("svg", {
				width: 13,
				height: 13,
				viewBox: "0 0 16 16",
				fill: "none",
				style: spinning ? { animation: "dsh-deepseek-usage-spin 0.8s linear infinite" } : void 0,
				children: jsx("path", {
					d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});

			const todayTokens = today && today.ok === true && today.tokens && typeof today.tokens === "object"
				? today.tokens
				: null;

			return jsx("div", {
				role: "status",
				"aria-live": "polite",
				"data-plugin": "dsh-deepseek-usage",
				title: "DeepSeek API 用量",
				style: card,
				children: jsxs(Fragment, {
					children: [
						jsxs("div", {
							style: headerRow,
							children: [
								dot,
								jsx("span", { style: title, children: "DeepSeek 用量" }),
								jsx("button", {
									type: "button",
									style: refreshButton,
									"aria-label": "刷新用量",
									title: "刷新",
									disabled: spinning,
									onClick: () => { load(); },
									children: refreshIcon
								})
							]
						}),
						phase === "loading"
							? jsx("div", { style: loadingText, children: "加载中…" })
							: phase === "error"
								? jsx("div", {
									style: errorText,
									title: message,
									children: message
								})
								: jsxs(Fragment, {
									children: [
										jsxs("div", {
											style: balanceRow,
											children: [
												jsx("span", { style: balanceValue, children: balanceInfo ? formatMoney(Number(balanceInfo.total_balance), currency) : "—" }),
												chip
											]
										}),
										todayCost !== null
											? jsx("div", {
												style: infoRow,
												title: today && today.note ? today.note : void 0,
												children: `${todaySource === "platform" ? "今日已消费" : "今日约消费"} ${formatMoney(todayCost, currency)}${todaySource === "log" ? " · 日志计价" : ""}`
											})
											: null,
										currentSessionId !== void 0 && conversationCost !== null
											? jsxs("div", {
												style: convCostRow,
												children: [
													jsx("span", { style: convCostLabel, children: "当前对话费用" }),
													jsx("span", { children: formatMoney(conversationCost, currency) }),
													jsx("span", {
														role: "button",
														tabIndex: 0,
														"aria-label": "查看当前对话费用计算公式",
														title: "查看计算公式",
														style: infoIcon,
														onMouseEnter: () => { setTipOpen(true); },
														onMouseLeave: () => { setTipOpen(false); },
														onFocus: () => { setTipOpen(true); },
														onBlur: () => { setTipOpen(false); },
														children: jsx("svg", {
															width: 13,
															height: 13,
															viewBox: "0 0 16 16",
															fill: "none",
															children: jsxs(Fragment, {
																children: [
																	jsx("circle", { cx: 8, cy: 8, r: 6.5, stroke: "currentColor", strokeWidth: 1.3 }),
																	jsx("path", { d: "M8 5v3.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
																	jsx("circle", { cx: 8, cy: 11.2, r: 0.9, fill: "currentColor" })
																]
															})
														})
													})
												]
											})
											: null,
										tipOpen && currentSessionId !== void 0 && conversationCost !== null && formulaLines.length > 0
											? jsx("div", {
												role: "tooltip",
												style: tipBox,
												children: jsxs(Fragment, {
													children: [
														jsx("div", { style: tipTitle, children: `当前对话费用 = ${formatMoney(conversationCost, currency)}` }),
														...formulaLines.map((b) => jsxs("div", {
															style: tipRow,
															children: [
																jsx("span", { style: tipLabel, children: b.label }),
																jsx("span", {
																	style: tipFormula,
																	children: `${formatTokens(b.tokens)} tok × ${formatRate(b.rate)} = ${formatMoney(b.subtotal, currency)}`
																})
															]
														}, b.label)),
														jsx("div", {
															style: tipFooter,
															children: `按消息时刻官方价格表计价（含峰谷）· 会话日志回放`
														})
													]
												})
											})
											: null,
										todayTokens !== null
											? jsx("div", {
												style: infoRow,
												children: `今日 tokens 输入 ${formatTokens(todayTokens.input)} · 缓存 ${formatTokens(todayTokens.cacheRead)} · 输出 ${formatTokens(todayTokens.output)}`
											})
											: null,
										jsxs("div", {
											style: metaRow,
											children: [
												jsx("span", { style: metaItem, children: `赠送 ${balanceInfo ? formatMoney(Number(balanceInfo.granted_balance), currency) : "—"}` }),
												jsx("span", { children: "·" }),
												jsx("span", { style: metaItem, children: `充值 ${balanceInfo ? formatMoney(Number(balanceInfo.topped_up_balance), currency) : "—"}` })
											]
										}),
										updatedAt
											? jsx("div", { style: updatedRow, children: `更新于 ${formatTime(updatedAt)}` })
											: null
									]
								})
					]
				})
			});
		}

		// ---- client plugin body -------------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "deepseek-usage",
				order: 100,
				label: "DeepSeek 用量"
			}, DeepSeekUsageCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
