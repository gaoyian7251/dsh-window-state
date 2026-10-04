window.__ModuleLoader__.load({
	id: "dsh-window-state",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react')

		/** lib/index.js STATE_KEY / DEFAULT_STATE — keep in sync. */
		const STATE_KEY = 'dsh-window-state:startup'
		const STATE_VALUES = ['default', 'maximized', 'fullscreen']
		const DEFAULT_STATE = 'default'
		const APPLY_ROUTE = '/dsh-window-state/apply'

		const ROW_STYLE_ID = 'dsh-window-state-row-style'

		/**
		 * The General-settings row sheet; DSH tokens so it matches either theme.
		 * Mirrors dsh-550c-boot's row layout so the new row sits visually beside it.
		 */
		const ROW_CSS = `
		.dshws-row{display:flex;align-items:center;gap:16px;padding:10px 0;flex-wrap:wrap}
		.dshws-row-text{flex:1;min-width:220px}
		.dshws-row-title{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#191919)}
		.dshws-row-desc{margin-top:2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666)}
		.dshws-row-ctrl{display:flex;align-items:center;gap:8px}
		.dshws-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:8px;overflow:hidden}
		.dshws-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-family:inherit;font-size:12.5px;line-height:1.4;padding:5px 14px;cursor:pointer}
		.dshws-seg button+button{border-left:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))}
		.dshws-seg button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
		.dshws-seg button.on{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
		.dshws-note{margin-top:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#666)}
		.dshws-note.ok{color:var(--dsw-alias-brand-primary,#4d6bfe)}
		.dshws-note.bad{color:var(--dsw-alias-label-error,#d4380d)}
		`

		function ensureRowStyle() {
			if (document.getElementById(ROW_STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = ROW_STYLE_ID
			style.textContent = ROW_CSS
			document.head.appendChild(style)
		}

		function readState() {
			try {
				const raw = window.localStorage.getItem(STATE_KEY)
				return STATE_VALUES.indexOf(raw) >= 0 ? raw : DEFAULT_STATE
			} catch (error) {
				return DEFAULT_STATE
			}
		}

		function writeState(state) {
			try {
				window.localStorage.setItem(STATE_KEY, state)
			} catch (error) {
				/* private mode: the choice simply does not persist */
			}
		}

		/** The General-settings row: 启动窗口状态 segmented control. */
		function SettingsRow() {
			const [state, setState] = React.useState(readState)
			const [note, setNote] = React.useState({ kind: 'idle', text: '' })

			React.useEffect(() => {
				ensureRowStyle()
			}, [])

			const choose = React.useCallback((next) => {
				writeState(next)
				setState(next)
				// 'default' needs no apply (it means "leave Electron alone").
				if (next === 'default') {
					setNote({ kind: 'idle', text: '' })
					return
				}
				setNote({ kind: 'applying', text: '正在应用…' })
				fetch(APPLY_ROUTE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ state: next }),
				})
					.then((response) => response.json())
					.then((result) => {
						if (result && result.ok) {
							setNote({ kind: 'ok', text: '已应用（下次启动自动生效）' })
						} else {
							setNote({
								kind: 'bad',
								text: '未能立即应用' + (result && result.error ? `（${result.error}）` : '') + '；下次启动会重试。',
							})
						}
					})
					.catch(() => {
						setNote({ kind: 'bad', text: '应用请求失败；下次启动会重试。' })
					})
			}, [])

			const options = [
				{ value: 'default', label: '默认' },
				{ value: 'maximized', label: '最大化' },
				{ value: 'fullscreen', label: '全屏' },
			]

			return React.createElement(
				'div',
				{ className: 'dshws-row' },
				React.createElement(
					'div',
					{ className: 'dshws-row-text' },
					React.createElement('div', { className: 'dshws-row-title' }, '启动窗口状态'),
					React.createElement(
						'div',
						{ className: 'dshws-row-desc' },
						'每次启动 DSH 桌面窗口时以所选状态打开（Windows）。',
					),
				),
				React.createElement(
					'div',
					{ className: 'dshws-row-ctrl' },
					React.createElement(
						'div',
						{ className: 'dshws-seg' },
						options.map((option) =>
							React.createElement(
								'button',
								{
									key: option.value,
									type: 'button',
									className: state === option.value ? 'on' : '',
									onClick: () => choose(option.value),
								},
								option.label,
							),
						),
					),
				),
				note.kind !== 'idle'
					? React.createElement(
							'div',
							{ className: 'dshws-note' + (note.kind === 'bad' ? ' bad' : note.kind === 'ok' ? ' ok' : '') },
							note.text,
						)
					: null,
			)
		}

		/**
		 * Mount the settings row into the General section.
		 *
		 * The slot name is inlined as a literal on purpose: the injector's
		 * pre-flight check reads register() calls statically and cannot follow a
		 * constant. order 25 sits between the boot-550c rows (26-28) and the
		 * composer-enter row (20).
		 */
		function apply(ctx) {
			ctx.slots.inject('settings.general.item', () =>
				ctx.slots.register({ name: 'settings.general.item', id: 'dsh-window-state', order: 25 }, SettingsRow),
			)
		}

		exports.name = 'dsh-window-state'
		exports.inject = ['slots']
		exports.apply = apply
		return module.exports;
	}
});
