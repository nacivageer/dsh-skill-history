/**
 * dsh-skill-history — Client half.
 *
 * One sidebar icon in `sidebar.panellist` (id `skill-history`) and the panel it
 * opens in the keyed `main` slot. The icon id is also the main-panel key: the
 * sidebar owns the button and selects the matching main cell.
 *
 * The panel polls the Host snapshot every 5 s:
 *
 *   GET  api/skill-history/data     skill calls per day, per session
 *   GET  api/skill-history/groups   the user's groups (empty on first run)
 *   POST api/skill-history/groups   save groups; the only write this plugin has
 *
 * Reading order is the supervision loop: day -> the sessions that used it ->
 * one session's skill breakdown with its cwd, plus a copy of the id/path.
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-history',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace; the same name is passed to the Slot registration. */
    const NS = 'skill-history';
    const PANEL_ID = 'skill-history';
    const ENDPOINT = 'api/skill-history/data';
    const GROUPS_ENDPOINT = 'api/skill-history/groups';
    const POLL_MS = 5_000;

    /** One palette for every group; dark-theme friendly, readable as a fill. */
    const PALETTE = ['#7aa2f7', '#7bdcb5', '#e5c07b', '#f199b6', '#b39ddb', '#65c8d0', '#ef7d7d', '#9ccc65'];

    /**
     * The stats pages borrow the Conversation page's transcript width so the
     * panel stops hugging the left edge on a wide window.
     *
     * `dsh-client-ui-conversation` owns that axis: `ConversationWidthControls`
     * measures the conversation body, then sets `--dsh-conversation-column-width`;
     * `.dsh-chat-content-width` resolves to 64% of it clamped to 680–920px, or
     * to the width the user dragged (localStorage `dsh.conversation.contentWidth`,
     * clamped to 640px…column-176px). Those CSS variables live on the conversation
     * root, which is not an ancestor of a different `main` panel, so the numbers
     * are reproduced here from the panel's own width.
     */
    const CONTENT_WIDTH_KEY = 'dsh.conversation.contentWidth';
    const CONTENT_MIN = 640;
    const CONTENT_EDGE_BUDGET = 176;

    function readContentWidthPreference() {
      try {
        const raw = window.localStorage.getItem(CONTENT_WIDTH_KEY);
        if (raw === null) return null;
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    }

    /** Same arithmetic as the Conversation page's `resolveContentWidth`. */
    function contentWidthFor(columnWidth) {
      const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET);
      const preference = readContentWidthPreference();
      if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max);
      return Math.max(680, Math.min(columnWidth * 0.64, 920));
    }

    /** Track the panel width and keep the centred column in step with it. */
    function usePageWidth(ref) {
      const [width, setWidth] = React.useState(null);
      React.useLayoutEffect(() => {
        const element = ref.current;
        if (element === null) return undefined;
        const measure = () => setWidth(contentWidthFor(element.clientWidth));
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        measure();
        return () => observer.disconnect();
      }, [ref]);
      return width;
    }

    const DICT = {
      en: {
        'title': 'Skill usage',
        'subtitle': 'Calls of the skill tool, per day',
        'status.scanning': 'Scanning sessions…',
        'status.failed': 'Cannot reach the Host route',
        'status.ok': '{calls} calls · {sessions} unique sessions',
        'status.updated': 'updated {time}',
        'status.badLines': '{n} unreadable lines skipped',
        'status.failedFiles': '{n} files could not be decoded',
        'status.error': 'Cannot read the session logs',
        'scan.zstd': 'This Host\'s Node cannot decode zstd logs (22.19+ required), so skill calls cannot be counted.',
        'scan.unreadable': 'The session logs could not be decoded. The log format may have changed; the panel shows an error rather than a wrong zero.',
        'chip.all': 'All',
        'chip.subagents': 'Subagents',
        'table.date': 'Date',
        'table.calls': 'Calls',
        'table.sessions': 'Sessions',
        'table.spread': 'Skills',
        'table.session': 'Session',
        'table.workspace': 'Workspace',
        'empty': 'No skill calls in this range.',
        'empty.error': 'Nothing to show until the session logs can be read.',
        'day.title': '{date} · {calls} calls · {sessions} sessions',
        'back': 'Back',
        'detail.calls': 'Calls',
        'detail.turns': 'Turns',
        'detail.first': 'First',
        'detail.last': 'Last',
        'detail.cwd': 'cwd',
        'detail.copy': 'Copy ID',
        'detail.copyPath': 'Copy path',
        'detail.copied': 'Copied',
        'detail.subagent': 'Subagent',
        'detail.archived': 'Archived',
        'detail.archivedNote': 'Archived session — read-only here; nothing is changed.',
        'detail.readOnlyNote': 'Read-only panel; open the session from the sidebar to continue.',
        'group.button': 'Groups',
        'group.title': 'Skill groups',
        'group.hint': 'Click a group tag on a skill row to put that skill in the group; one skill can sit in several groups. Group members are ordered by call count.',
        'group.name': 'Group name',
        'group.add': 'New group',
        'group.remove': 'Remove',
        'group.save': 'Save',
        'group.cancel': 'Cancel',
        'group.saving': 'Saving…',
        'group.saved': 'Saved',
        'group.error': 'Save failed; the existing file is unchanged.',
        'group.dup': 'Group names must be unique and non-empty.',
        'group.empty': 'No groups yet.',
        'group.search': 'Search skills',
        'group.ungrouped': 'Ungrouped',
        'group.noMatch': 'No skill matches.',
        'group.groupsPane': 'Groups',
        'group.newName': 'Group {n}',
        'group.noMembers': 'Empty — click a group tag on the left to add skills.',
        'group.removeSkill': 'Remove from group',
        'group.callCount': '{n} calls',
        'group.dirty': 'Unsaved changes',
        'group.color': 'Colour',
        'group.colorNone': 'No colour (neutral)',
        'group.assign': 'Add to group',
        'group.noGroupsHint': 'No groups yet — create one on the right.',
        'skills.button': 'All skills',
        'skills.title': 'All skills',
        'skills.subtitle': '{n} skills',
        'skills.name': 'Skill',
        'skills.created': 'Created',
        'skills.description': 'Description',
        'skills.builtin': 'Built-in',
        'skills.ungrouped': 'Ungrouped',
        'skills.empty': 'No skills to show.',
        'skills.expandHint': 'Click a row to expand its full description.',
        'skills.note': 'Grouped by type, newest first inside each group; a skill in several groups appears under each. Built-in skills ship with DSH and have no per-skill creation date.',
        'obs.title': 'Unused skills',
        'obs.note': 'Rule-only skills never appear here: their rules live in AGENTS.md, not in a call.',
      },
      zh: {
        'title': '技能使用统计',
        'subtitle': '按天统计 skill 工具的调用',
        'status.scanning': '正在扫描会话……',
        'status.failed': '连不上 Host 路由',
        'status.ok': '{calls} 次调用 · {sessions} 个独立会话',
        'status.updated': '{time} 更新',
        'status.badLines': '跳过 {n} 行坏行',
        'status.failedFiles': '{n} 个文件无法解压',
        'status.error': '无法读取会话日志',
        'scan.zstd': '当前 Host 的 Node 不支持 zstd（需要 22.19+），因此无法统计技能调用。',
        'scan.unreadable': '会话日志无法解压，日志格式可能已变化；面板宁可显示错误，也不显示错误的 0。',
        'chip.all': '全部',
        'chip.subagents': '含子代理',
        'table.date': '日期',
        'table.calls': '次数',
        'table.sessions': '会话',
        'table.spread': '技能分布',
        'table.session': '会话',
        'table.workspace': '工作区',
        'empty': '这个范围内没有技能调用。',
        'empty.error': '会话日志读不出来之前，没有可显示的数据。',
        'day.title': '{date} · {calls} 次 · {sessions} 个会话',
        'back': '返回',
        'detail.calls': '调用',
        'detail.turns': '轮次',
        'detail.first': '首次',
        'detail.last': '末次',
        'detail.cwd': '路径',
        'detail.copy': '复制 ID',
        'detail.copyPath': '复制路径',
        'detail.copied': '已复制',
        'detail.subagent': '子代理',
        'detail.archived': '已归档',
        'detail.archivedNote': '归档会话：这里只读查看，不改动它的状态。',
        'detail.readOnlyNote': '只读面板；要继续对话请从左侧工作区打开。',
        'group.button': '分组',
        'group.title': '技能分组',
        'group.hint': '点技能行上的组标签即可归组，一个技能可以同时属于多个组。右侧组的成员按调用次数从高到低排列。',
        'group.name': '组名',
        'group.add': '新建组',
        'group.remove': '删除',
        'group.save': '保存',
        'group.cancel': '取消',
        'group.saving': '保存中……',
        'group.saved': '已保存',
        'group.error': '保存失败，原文件未改动。',
        'group.dup': '组名不能为空，也不能重名。',
        'group.empty': '还没有分组。',
        'group.search': '搜索技能',
        'group.ungrouped': '未分组',
        'group.noMatch': '没有匹配的技能。',
        'group.groupsPane': '分组',
        'group.newName': '新分组 {n}',
        'group.noMembers': '还没有技能，点左侧技能行的组标签加入。',
        'group.removeSkill': '移出组',
        'group.callCount': '{n} 次',
        'group.dirty': '有改动未保存',
        'group.color': '组色',
        'group.colorNone': '不设颜色（中性）',
        'group.assign': '归组',
        'group.noGroupsHint': '还没有分组，先在右边新建一个。',
        'skills.button': '技能一览',
        'skills.title': '技能一览',
        'skills.subtitle': '{n} 个技能',
        'skills.name': '技能',
        'skills.created': '建立',
        'skills.description': '功能描述',
        'skills.builtin': '内置',
        'skills.ungrouped': '未分组',
        'skills.empty': '没有可显示的技能。',
        'skills.expandHint': '点击对应行，即可展开查看详细描述',
        'skills.note': '按类型分组，组内按建立时间从新到旧；同一技能属于多个组时会在各组下各出现一次。内置技能随 DSH 提供，没有单独的建立日期。',
        'obs.title': '零调用技能',
        'obs.note': '规则型技能不会出现在这里：它们的规则写在 AGENTS.md 里，没有调用可数。',
      },
    };

    const CSS = `
.dss{box-sizing:border-box;height:100%;width:100%;max-width:100%;min-width:0;overflow:auto;padding:20px 24px 40px;font:inherit;color:var(--dsw-alias-label-primary)}
.dss__page{width:100%;max-width:100%;min-width:0;margin:0 auto}
.dss__head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dss__title{font-size:16px;font-weight:600}
.dss__meta{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.dss__dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);margin:0 6px 0 0;vertical-align:1px}
.dss__dot[data-tone=bad]{background:var(--dsw-alias-state-error-primary)}
.dss__subtitle{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:13px;margin:4px 0 14px}
.dss__subtitleText{min-width:0}
.dss__expandHint{margin-left:auto;color:var(--dsw-alias-label-secondary);opacity:.75;font-size:13px;white-space:nowrap}
.dss__bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.dss__chip{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;padding:7px 12px;border-radius:999px;cursor:pointer}
.dss__chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dss__chip[data-on=true]{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dss__chip--action{border-style:dashed}
.dss__count{opacity:.6;margin-left:4px;font-size:13px;font-variant-numeric:tabular-nums}
.dss__table{display:flex;flex-direction:column;gap:2px}
.dss__row{display:grid;grid-template-columns:88px 64px 64px minmax(0,1fr);gap:12px;align-items:baseline;padding:8px 10px;border-radius:8px;font-size:14px}
.dss__row--day{cursor:pointer;transition:background .12s ease}
.dss__row--dayHead,.dss__row--day{grid-template-columns:104px 64px 64px minmax(0,1fr)}
.dss__row--dayHead .dss__spread,.dss__row--day .dss__spread{padding-left:28px}
.dss__row[data-tone=light]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.dss__row[data-tone=deep]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}
.dss__row[data-tone=light]:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 11%,transparent)}
.dss__row[data-tone=deep]:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}
.dss__row.dss__row--day[data-today=true]{background:#1e3a8a;color:#eef2ff}
.dss__row.dss__row--day[data-today=true]:hover{background:#25479b}
.dss__row--day[data-today=true] .dss__spread{color:#c3cee8}
.dss__row--head{color:var(--dsw-alias-label-secondary);font-size:13px;padding-top:0;padding-bottom:4px}
.dss__row--session{grid-template-columns:minmax(0,1fr) minmax(0,1.05fr) 56px;cursor:pointer;transition:background .12s ease}
.dss__date{font-variant-numeric:tabular-nums;font-weight:500}
.dss__num{font-variant-numeric:tabular-nums;text-align:right}
.dss__spread{color:var(--dsw-alias-label-secondary);min-width:0}
.dss__dist{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.dss__distItem{display:inline-flex;align-items:baseline;gap:4px;font-size:14px;line-height:1;padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dss__distItem b{color:var(--dsw-alias-label-primary);font-weight:600}
.dss__distMore{opacity:.7;border-style:dashed}
.dss__row--day[data-today=true] .dss__distItem{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.3);color:#dfe7fa}
.dss__row--day[data-today=true] .dss__distItem b{color:#fff}
.dss__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dss__ws{color:var(--dsw-alias-label-secondary);font-size:13px;margin-left:8px}
.dss__badge{font-size:11px;line-height:1;padding:2px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);margin-left:6px;vertical-align:1px}
.dss__back{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;padding:2px 0;margin-bottom:8px}
.dss__back:hover{color:var(--dsw-alias-label-primary)}
.dss__detail{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;margin-top:8px}
.dss__detailTitle{font-size:15px;font-weight:600;margin-bottom:2px}
.dss__kv{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--dsw-alias-label-secondary);font-size:14px;margin-top:8px;font-variant-numeric:tabular-nums}
.dss__kv b{color:var(--dsw-alias-label-primary);font-weight:500}
.dss__cwd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all;color:var(--dsw-alias-label-secondary);margin-top:6px}
.dss__rows{margin-top:12px;display:flex;flex-direction:column;gap:3px}
.dss__skillRow{display:flex;align-items:baseline;gap:10px;font-size:14px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dss__skillRow:last-child{border-bottom:0}
.dss__skillCount{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dss__actions{display:flex;gap:8px;margin-top:14px}
.dss__btn{font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;cursor:pointer}
.dss__btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dss__btn--primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-label-primary)}
.dss__empty{padding:28px 0;color:var(--dsw-alias-label-secondary);font-size:13px}
.dss__zero{margin-top:22px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}
.dss__zeroTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dss__zeroList{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-secondary);word-break:normal;overflow-wrap:anywhere}
.dss__zeroNote{font-size:12px;color:var(--dsw-alias-label-secondary);opacity:.75;margin-top:6px}
.dss__navBtn{font:inherit;font-size:14px;line-height:1;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:7px 12px;cursor:pointer;white-space:nowrap}
.dss__navBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dss__head .dss__back{margin-bottom:0}
.dss__row--skillHead,.dss__row--skill{grid-template-columns:minmax(190px,260px) 92px minmax(0,1fr);column-gap:18px;padding:8px 10px}
.dss__row--skillHead{align-items:baseline;padding-top:0;padding-bottom:6px;font-size:13px}
.dss__section{margin-top:14px}
.dss__section + .dss__section{padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dss__sectionHead{display:flex;align-items:baseline;gap:8px;padding:0 10px 5px}
.dss__sectionHead .dss__colorDot{margin-right:0}
.dss__sectionTitle{font-size:15px;font-weight:600}
.dss__sectionCount{font-size:13px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dss__row--skill{align-items:baseline;border-radius:8px;cursor:pointer;transition:background .12s ease}
.dss__row--skill[data-tone]:hover{background:#1e3a8a}
.dss__row--skill[data-tone]:hover .dss__created,
.dss__row--skill[data-tone]:hover .dss__skillCount,
.dss__row--skill[data-tone]:hover .dss__desc{color:#c7d2ea}
.dss__row--skill[data-open=true]{box-shadow:inset 3px 0 0 #3b82f6}
.dss__row--skill:focus-visible{outline:2px solid #3b82f6;outline-offset:-2px}
.dss__row--skill .dss__desc{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.dss__row--skill[data-open=true] .dss__desc{display:block;-webkit-line-clamp:unset;overflow:visible}
.dss__nameCell{display:flex;align-items:baseline;gap:10px;min-width:0}
.dss__nameCell .dss__skillName{word-break:normal;overflow-wrap:anywhere;line-height:1.35}
.dss__skillCount{margin-left:auto;font-size:13px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dss__created{color:var(--dsw-alias-label-secondary);font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dss__desc{font-size:14px;line-height:1.55;color:var(--dsw-alias-label-secondary);word-break:break-word;max-width:920px;padding-bottom:0}
.dss__modal{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px}
.dss__card{width:min(680px,100%);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px 20px;box-shadow:0 24px 60px rgba(0,0,0,.35)}
.dss__cardTitle{font-size:15px;font-weight:600;margin-bottom:2px}
.dss__hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:14px}
.dss__input{font:inherit;font-size:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 9px;min-width:0}
.dss__input:focus{outline:none;border-color:var(--dsw-alias-label-secondary)}
.dss__x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;cursor:pointer;line-height:1}
.dss__x:hover{color:var(--dsw-alias-state-error-primary)}
.dss__card--wide{width:min(920px,100%);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
.dss__market{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:14px;margin-top:12px;flex:0 0 auto;height:min(54vh,520px)}
.dss__pane{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.dss__paneHead{display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);flex:0 0 auto}
.dss__paneTitle{font-size:12px;font-weight:600;flex:1;min-width:0}
.dss__search{flex:1;min-width:0}
.dss__paneBody{overflow:auto;flex:1 1 auto;min-height:0;padding:4px 5px}
.dss__skillRow{border-radius:8px;padding:1px 0}
.dss__skillRow:hover{background:var(--dsw-alias-bg-layer-2)}
.dss__skillLine{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:5px 7px}
.dss__addTag{font:inherit;font-size:11px;line-height:1;font-weight:600;padding:4px 7px;border-radius:999px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dss__addTag:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
.dss__addTag[data-on=true]{border-style:solid;border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
.dss__picker{display:flex;flex-wrap:wrap;gap:5px;margin:0 6px 8px 14px;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:0 8px 8px 0}
.dss__skillName{font-size:14px;word-break:break-all}
.dss__grow{flex:1;min-width:8px}
.dss__callCount{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dss__tag{font:inherit;font-size:12px;font-weight:600;line-height:1;padding:4px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dss__tag:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}
.dss__tag[data-on=true]{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}
.dss__tagCount{opacity:.72;margin-left:4px;font-variant-numeric:tabular-nums;font-weight:600}
.dss__swatches{display:flex;align-items:center;gap:6px;margin-top:7px;flex-wrap:wrap}
.dss__swatch{width:13px;height:13px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:transparent;padding:0;cursor:pointer;position:relative}
.dss__swatch[data-on=true]{outline:1px solid var(--dsw-alias-label-primary);outline-offset:1px}
.dss__swatch--none::after{content:'';position:absolute;left:1px;right:1px;top:50%;height:1px;background:var(--dsw-alias-label-secondary);transform:rotate(-45deg)}
.dss__colorDot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}
.dss__tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.dss__groupCard{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:7px 9px;margin-bottom:7px}
.dss__groupHead{display:flex;align-items:center;gap:7px}
.dss__groupName{flex:1;min-width:0}
.dss__groupEmpty{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8;margin-top:6px}
.dss__empty--tight{padding:18px 4px;font-size:12px}
.dss__err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:8px}
.dss__banner{margin:8px 0 4px;padding:9px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:1.5}
.dss__ok{color:var(--dsw-alias-state-success-primary);font-size:12px;margin-left:8px}
`;

    function fill(text, values) {
      return String(text ?? '').replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? ''));
    }

    const pad = (value) => String(value).padStart(2, '0');

    function timeText(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—';
      const date = new Date(ms);
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function dateText(ms) {
      if (typeof ms !== 'number' || ms <= 0) return null;
      const date = new Date(ms);
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function dateTimeText(ms) {
      const day = dateText(ms);
      return day === null ? null : `${day} ${timeText(ms)}`;
    }

    /**
     * Local calendar day of a timestamp. The Host buckets calls with the same
     * local-day rule, so comparing this string against `day.date` is exact.
     */
    function dayKey(ms) {
      if (typeof ms !== 'number' || ms <= 0) return null;
      return dateText(ms);
    }

    function shortId(id) {
      return String(id ?? '').replace(/^session-/, '').slice(0, 8);
    }

    /** Inline colours for a group tag; null keeps the neutral theme colours. */
    function tagTone(color, on) {
      if (typeof color !== 'string' || color === '') return null;
      return on
        ? { background: color, borderColor: color, color: '#15161a' }
        : { borderColor: color, color };
    }

    /** Each "memory 6" as a pill; a trailing +N pill when the list is cut. */
    function spreadNode(bySkill, limit) {
      const pairs = Object.entries(bySkill ?? {}).sort((a, b) => b[1] - a[1]);
      const shown = pairs.slice(0, limit);
      const rest = pairs.length - shown.length;
      return h('span', { className: 'dss__dist' },
        shown.map(([name, count]) => h('span', { key: name, className: 'dss__distItem' },
          name,
          h('b', null, count))),
        rest > 0 ? h('span', { key: '#more', className: 'dss__distItem dss__distMore' }, `+${rest}`) : null,
      );
    }

    function filterDays(rawDays, active, includeSubagents) {
      const days = [];
      for (const day of rawDays ?? []) {
        let calls = 0;
        const sessions = [];
        for (const session of day.sessions ?? []) {
          if (!includeSubagents && session.depth > 0) continue;
          let count = 0;
          const bySkill = {};
          for (const [skill, value] of Object.entries(session.bySkill ?? {})) {
            if (active !== null && !active.has(skill)) continue;
            count += value;
            bySkill[skill] = value;
          }
          if (count === 0) continue;
          sessions.push({ ...session, calls: count, bySkill });
          calls += count;
        }
        if (calls === 0) continue;
        days.push({ ...day, calls, sessions });
      }
      return days;
    }

    /** Newest first; built-ins have no real date and sort last. */
    function byCreated(a, b) {
      const left = typeof a.createdAt === 'number' && a.createdAt > 0 ? a.createdAt : null;
      const right = typeof b.createdAt === 'number' && b.createdAt > 0 ? b.createdAt : null;
      if (left === null && right === null) return a.name.localeCompare(b.name);
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left || a.name.localeCompare(b.name);
    }

    /** Poll the Host snapshot; keep the last good value across a failed poll. */
    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        let timer;
        let controller;
        let misses = 0;
        const load = async () => {
          if (!alive) return;
          controller = new AbortController();
          try {
            const response = await fetch(ENDPOINT, {
              cache: 'no-store',
              credentials: 'same-origin',
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (!alive) return;
            misses = 0;
            setFailed(false);
            setSnapshot(data);
          } catch (cause) {
            if (!alive || cause?.name === 'AbortError') return;
            misses += 1;
            if (misses >= 3) setFailed(true);
          }
          if (alive) timer = setTimeout(load, POLL_MS);
        };
        load();
        const onVisible = () => {
          if (document.hidden === true) return;
          clearTimeout(timer);
          load();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          alive = false;
          clearTimeout(timer);
          controller?.abort();
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, []);
      return { snapshot, failed };
    }

    function useGroups() {
      const [groups, setGroups] = React.useState(null);
      const [colors, setColors] = React.useState({});
      const [defaults, setDefaults] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(null);

      const reload = React.useCallback(async () => {
        try {
          const response = await fetch(GROUPS_ENDPOINT, { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          setGroups(data.groups ?? {});
          setColors(data.colors ?? {});
          setDefaults(data.defaults !== false);
          setError(null);
        } catch {
          setError('load');
        }
      }, []);

      React.useEffect(() => { void reload(); }, [reload]);

      const save = React.useCallback(async (next, nextColors) => {
        setSaving(true);
        setError(null);
        try {
          const response = await fetch(GROUPS_ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ groups: next, colors: nextColors ?? {} }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
          setGroups(data.groups ?? next);
          setColors(data.colors ?? nextColors ?? {});
          setDefaults(false);
          return true;
        } catch {
          setError('save');
          return false;
        } finally {
          setSaving(false);
        }
      }, []);

      return { groups, colors, defaults, saving, error, reload, save };
    }

    /** Filled bars read at 16px; a 2px stroke on a 24px grid did not. */
    function PanelIcon({ size = 18, active }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'currentColor',
        'aria-hidden': true,
        opacity: active ? 1 : 0.9,
      },
        h('rect', { x: 3, y: 13, width: 4.6, height: 8, rx: 1.6 }),
        h('rect', { x: 9.7, y: 8.5, width: 4.6, height: 12.5, rx: 1.6 }),
        h('rect', { x: 16.4, y: 3.5, width: 4.6, height: 17.5, rx: 1.6 }),
      );
    }

    /**
     * Marketplace-shaped editor: the skill list is the left pane (one row per
     * skill, a tag per group), the groups are cards on the right. Picking a
     * group is a click on a tag — no comma-separated names to type or mistype.
     * Membership lives in `rows[].members`; a skill may sit in several groups.
     */
    function GroupsEditor({ t, groups, colors, skills, saving, error, onClose, onSave }) {
      const initial = React.useMemo(() => Object.entries(groups ?? {}).map(([name, members], index) => ({
        id: `g${index}`,
        name,
        members: [...members],
        color: colors?.[name] ?? null,
      })), [groups, colors]);
      const [rows, setRows] = React.useState(initial);
      const [query, setQuery] = React.useState('');
      const [onlyUngrouped, setOnlyUngrouped] = React.useState(false);
      const [openRow, setOpenRow] = React.useState(null);
      const [message, setMessage] = React.useState(null);
      const nextId = React.useRef(initial.length);

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);

      const countOf = React.useMemo(() => {
        const map = new Map();
        for (const entry of skills ?? []) map.set(entry.name, entry.count ?? 0);
        return (name) => map.get(name) ?? 0;
      }, [skills]);

      /** Catalog order, plus any name a saved group still holds. */
      const allSkills = React.useMemo(() => {
        const seen = new Set();
        const list = [];
        for (const entry of skills ?? []) {
          if (seen.has(entry.name)) continue;
          seen.add(entry.name);
          list.push({ name: entry.name, count: entry.count ?? 0 });
        }
        for (const row of rows) {
          for (const member of row.members) {
            if (seen.has(member)) continue;
            seen.add(member);
            list.push({ name: member, count: 0 });
          }
        }
        return list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      }, [skills, rows]);

      /** skill -> the ids of the groups it is in. */
      const membership = React.useMemo(() => {
        const map = new Map();
        for (const row of rows) {
          for (const member of row.members) {
            const set = map.get(member) ?? new Set();
            set.add(row.id);
            map.set(member, set);
          }
        }
        return map;
      }, [rows]);

      const needle = query.trim().toLowerCase();
      const visible = allSkills.filter((entry) => {
        if (needle !== '' && !entry.name.toLowerCase().includes(needle)) return false;
        if (onlyUngrouped) return !membership.has(entry.name);
        return true;
      });
      const ungroupedCount = allSkills.filter((entry) => !membership.has(entry.name)).length;

      const dirty = React.useMemo(() => JSON.stringify(rows.map((row) => [row.name, row.members, row.color]))
        !== JSON.stringify(initial.map((row) => [row.name, row.members, row.color])), [rows, initial]);

      const toggle = (id, skill) => {
        setRows((current) => current.map((row) => {
          if (row.id !== id) return row;
          return row.members.includes(skill)
            ? { ...row, members: row.members.filter((item) => item !== skill) }
            : { ...row, members: [...row.members, skill] };
        }));
      };

      const removeMember = (id, skill) => {
        setRows((current) => current.map((row) => (
          row.id === id ? { ...row, members: row.members.filter((item) => item !== skill) } : row
        )));
      };

      const addGroup = () => {
        const used = new Set(rows.map((row) => row.name));
        let index = rows.length + 1;
        let name = fill(t('group.newName'), { n: index });
        while (used.has(name)) {
          index += 1;
          name = fill(t('group.newName'), { n: index });
        }
        const id = `g${nextId.current}`;
        nextId.current += 1;
        setRows([...rows, { id, name, members: [], color: null }]);
      };

      const setColor = (id, color) => {
        setRows((current) => current.map((row) => (row.id === id ? { ...row, color } : row)));
      };

      /** Highest count first; the array is written in that order. */
      const orderedMembers = (row) => [...row.members]
        .sort((a, b) => countOf(b) - countOf(a) || a.localeCompare(b));

      const submit = async () => {
        const next = {};
        const nextColors = {};
        for (const row of rows) {
          const name = row.name.trim();
          if (name === '') { setMessage(t('group.dup')); return; }
          if (Object.hasOwn(next, name)) { setMessage(t('group.dup')); return; }
          next[name] = orderedMembers(row);
          if (row.color !== null) nextColors[name] = row.color;
        }
        setMessage(null);
        const ok = await onSave(next, nextColors);
        if (ok) onClose();
      };

      return h('div', {
        className: 'dss__modal',
        role: 'dialog',
        'aria-modal': 'true',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
      },
        h('div', { className: 'dss__card dss__card--wide' },
          h('div', { className: 'dss__cardTitle' }, t('group.title')),
          h('div', { className: 'dss__hint' }, t('group.hint')),

          h('div', { className: 'dss__market' },
            h('div', { className: 'dss__pane' },
              h('div', { className: 'dss__paneHead' },
                h('input', {
                  className: 'dss__input dss__search',
                  value: query,
                  placeholder: t('group.search'),
                  'aria-label': t('group.search'),
                  autoFocus: true,
                  onChange: (event) => setQuery(event.target.value),
                }),
                h('button', {
                  className: 'dss__chip',
                  'data-on': onlyUngrouped,
                  onClick: () => setOnlyUngrouped((value) => !value),
                }, t('group.ungrouped'), h('span', { className: 'dss__count' }, ungroupedCount)),
              ),
              h('div', { className: 'dss__paneBody' },
                visible.length === 0
                  ? h('div', { className: 'dss__empty dss__empty--tight' }, t('group.noMatch'))
                  : visible.map((entry) => {
                    const assigned = rows.filter((row) => row.members.includes(entry.name));
                    const open = openRow === entry.name;
                    return h('div', { className: 'dss__skillRow', key: entry.name },
                      h('div', { className: 'dss__skillLine' },
                        h('span', { className: 'dss__skillName' }, entry.name),
                        h('span', { className: 'dss__callCount' }, fill(t('group.callCount'), { n: entry.count })),
                        h('span', { className: 'dss__grow' }),
                        assigned.map((row) => h('button', {
                          key: row.id,
                          className: 'dss__tag',
                          'data-on': true,
                          style: row.color === null ? null : tagTone(row.color, true),
                          title: `${row.name} — ${t('group.removeSkill')}`,
                          onClick: () => toggle(row.id, entry.name),
                        }, row.name)),
                        rows.length === 0 ? null : h('button', {
                          className: 'dss__addTag',
                          'data-on': open,
                          title: t('group.assign'),
                          'aria-expanded': open,
                          onClick: () => setOpenRow(open ? null : entry.name),
                        }, open ? '−' : (assigned.length === 0 ? `＋ ${t('group.assign')}` : '＋')),
                      ),
                      open
                        ? h('div', { className: 'dss__picker' },
                          rows.length === 0
                            ? h('span', { className: 'dss__callCount' }, t('group.noGroupsHint'))
                            : rows.map((row) => h('button', {
                              key: row.id,
                              className: 'dss__tag',
                              'data-on': row.members.includes(entry.name),
                              style: tagTone(row.color, row.members.includes(entry.name)),
                              onClick: () => toggle(row.id, entry.name),
                            }, row.name)),
                        )
                        : null,
                    );
                  }),
              ),
            ),

            h('div', { className: 'dss__pane' },
              h('div', { className: 'dss__paneHead' },
                h('span', { className: 'dss__paneTitle' }, t('group.groupsPane')),
                h('button', {
                  className: 'dss__chip dss__chip--action',
                  onClick: addGroup,
                }, t('group.add')),
              ),
              h('div', { className: 'dss__paneBody' },
                rows.length === 0
                  ? h('div', { className: 'dss__empty dss__empty--tight' }, t('group.empty'))
                  : rows.map((row) => h('div', {
                    className: 'dss__groupCard',
                    key: row.id,
                    style: row.color === null ? null : { borderLeft: `3px solid ${row.color}` },
                  },
                    h('div', { className: 'dss__groupHead' },
                      h('input', {
                        className: 'dss__input dss__groupName',
                        value: row.name,
                        placeholder: t('group.name'),
                        'aria-label': t('group.name'),
                        onChange: (event) => {
                          const name = event.target.value;
                          setRows((current) => current.map((item) => (
                            item.id === row.id ? { ...item, name } : item
                          )));
                        },
                      }),
                      h('span', { className: 'dss__callCount' }, row.members.length),
                      h('button', {
                        className: 'dss__x',
                        title: t('group.remove'),
                        'aria-label': t('group.remove'),
                        onClick: () => setRows((current) => current.filter((item) => item.id !== row.id)),
                      }, '×'),
                    ),
                    h('div', { className: 'dss__swatches', role: 'group', 'aria-label': t('group.color') },
                      h('button', {
                        className: 'dss__swatch dss__swatch--none',
                        'data-on': row.color === null,
                        title: t('group.colorNone'),
                        'aria-label': t('group.colorNone'),
                        onClick: () => setColor(row.id, null),
                      }),
                      PALETTE.map((color) => h('button', {
                        key: color,
                        className: 'dss__swatch',
                        'data-on': row.color === color,
                        style: { background: color },
                        title: color,
                        'aria-label': color,
                        onClick: () => setColor(row.id, color),
                      })),
                    ),
                    row.members.length === 0
                      ? h('div', { className: 'dss__groupEmpty' }, t('group.noMembers'))
                      : h('div', { className: 'dss__tags' },
                        orderedMembers(row).map((skill) => h('button', {
                          key: skill,
                          className: 'dss__tag',
                          'data-on': true,
                          style: row.color === null ? null : tagTone(row.color, true),
                          title: t('group.removeSkill'),
                          onClick: () => removeMember(row.id, skill),
                        }, skill, h('span', { className: 'dss__tagCount' }, countOf(skill)))),
                      ),
                  )),
              ),
            ),
          ),

          h('div', { className: 'dss__actions' },
            dirty ? h('span', { className: 'dss__callCount' }, t('group.dirty')) : null,
            h('span', { style: { marginLeft: 'auto' } }),
            h('button', { className: 'dss__btn', onClick: onClose }, t('group.cancel')),
            h('button', {
              className: 'dss__btn dss__btn--primary',
              disabled: saving,
              onClick: () => { void submit(); },
            }, saving ? t('group.saving') : t('group.save')),
          ),
          message === null ? null : h('div', { className: 'dss__err' }, message),
          error === 'save' ? h('div', { className: 'dss__err' }, t('group.error')) : null,
        ),
      );
    }

    function Panel({ t }) {
      const { snapshot, failed } = useSnapshot();
      const library = useGroups();
      const [selected, setSelected] = React.useState([]);
      const [includeSubagents, setIncludeSubagents] = React.useState(true);
      const [view, setView] = React.useState({ level: 'days' });
      const [editing, setEditing] = React.useState(false);
      const [copied, setCopied] = React.useState(false);
      /** The one inventory row whose full description is open, if any. */
      const [openSkill, setOpenSkill] = React.useState(null);
      const pageRef = React.useRef(null);
      const pageWidth = usePageWidth(pageRef);

      const toggleSkill = React.useCallback((name) => {
        setOpenSkill((current) => (current === name ? null : name));
      }, []);

      const groups = library.groups ?? {};
      const groupColors = library.colors ?? {};
      const groupNames = Object.keys(groups);

      const active = React.useMemo(() => {
        if (selected.length === 0) return null;
        const set = new Set();
        for (const name of selected) {
          for (const skill of groups[name] ?? []) set.add(skill);
        }
        return set;
      }, [selected, groups]);

      const days = React.useMemo(
        () => filterDays(snapshot?.days, active, includeSubagents),
        [snapshot, active, includeSubagents],
      );

      /* Today per the Host clock: day buckets are cut there, so trust it over the browser zone. */
      const today = dayKey(snapshot?.now);

      const totals = React.useMemo(() => {
        let calls = 0;
        const sessions = new Set();
        for (const day of days) {
          calls += day.calls;
          for (const session of day.sessions) sessions.add(session.id);
        }
        return { calls, sessions: sessions.size };
      }, [days]);

      /**
       * The inventory, grouped by the user's own groups in their defined order.
       * A skill in several groups appears under each; a group member missing
       * from the catalog still gets a stub row, and leftovers close the page as
       * "未分组".
       */
      const sections = React.useMemo(() => {
        const entries = new Map((snapshot?.skills ?? []).map((entry) => [entry.name, entry]));
        const seen = new Set();
        const list = [];
        for (const [name, members] of Object.entries(groups)) {
          const skills = [];
          for (const skill of members) {
            const entry = entries.get(skill) ?? {
              name: skill,
              count: 0,
              source: 'observed',
              description: '',
              createdAt: null,
            };
            skills.push(entry);
            seen.add(skill);
          }
          if (skills.length === 0) continue;
          skills.sort(byCreated);
          list.push({ name, color: groupColors[name] ?? null, skills });
        }
        const rest = [...entries.values()].filter((entry) => !seen.has(entry.name)).sort(byCreated);
        if (rest.length > 0) {
          list.push({ name: t('skills.ungrouped'), color: null, skills: rest });
        }
        return list;
      }, [snapshot, groups, groupColors, t]);

      const known = (snapshot?.skills ?? []).map((entry) => entry.name);
      const zeroSkills = (snapshot?.skills ?? [])
        .filter((entry) => entry.count === 0 && (active === null || active.has(entry.name)))
        .map((entry) => entry.name);
      const scan = snapshot?.scan;
      const scanning = snapshot === null || scan?.ready !== true;

      let status = t('status.scanning');
      let tone = 'ok';
      if (failed) {
        status = t('status.failed');
        tone = 'bad';
      } else if (scan?.error) {
        // Never dress an unreadable log set up as "0 calls": that reads as
        // "no skill was used", which is a different and wrong statement.
        status = t('status.error');
        tone = 'bad';
      } else if (!scanning) {
        status = fill(t('status.ok'), { calls: totals.calls, sessions: totals.sessions });
      }

      const meta = [];
      if (scan?.ready) {
        meta.push(fill(t('status.updated'), { time: timeText(scan.at) }));
        if ((scan.badLines ?? 0) > 0) meta.push(fill(t('status.badLines'), { n: scan.badLines }));
        if ((scan.failedFiles ?? 0) > 0) meta.push(fill(t('status.failedFiles'), { n: scan.failedFiles }));
      }

      // The panel line follows the view: "142 calls" is the day table's
      // headline, not the inventory's.
      const inSkills = view.level === 'skills';
      const subtitleText = inSkills
        ? [
          fill(t('skills.subtitle'), { n: known.length }),
          failed || scanning ? status : null,
          ...meta,
        ].filter(Boolean).join(' · ')
        : [t('subtitle'), status, ...meta].join(' · ');

      const openDay = view.level === 'days' ? null : days.find((day) => day.date === view.date) ?? null;
      const openSession = openDay === null ? null : openDay.sessions.find((session) => session.id === view.id) ?? null;

      const copyId = async (id) => {
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        } catch {
          setCopied(false);
        }
      };

      const chips = [
        h('button', {
          key: '__all',
          className: 'dss__chip',
          'data-on': selected.length === 0,
          onClick: () => setSelected([]),
        }, t('chip.all'), h('span', { className: 'dss__count' }, known.length)),
        ...groupNames.map((name) => h('button', {
          key: name,
          className: 'dss__chip',
          'data-on': selected.includes(name),
          onClick: () => setSelected((current) => (
            current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
          )),
        },
          groupColors[name] ? h('span', { className: 'dss__colorDot', style: { background: groupColors[name] } }) : null,
          name,
          h('span', { className: 'dss__count' }, (groups[name] ?? []).length))),
        h('button', {
          key: '__sub',
          className: 'dss__chip',
          'data-on': includeSubagents,
          onClick: () => setIncludeSubagents((value) => !value),
        }, t('chip.subagents')),
        h('button', {
          key: '__edit',
          className: 'dss__chip dss__chip--action',
          onClick: () => setEditing(true),
        }, t('group.button')),
      ];

      let body;
      if (inSkills) {
        body = sections.length === 0
          ? h('div', { className: 'dss__empty' }, scanning ? t('status.scanning') : t('skills.empty'))
          : h(React.Fragment, null,
            h('div', { className: 'dss__row dss__row--head dss__row--skillHead', role: 'row' },
              h('span', null, t('skills.name')),
              h('span', null, t('skills.created')),
              h('span', null, t('skills.description')),
            ),
            sections.map((section, sectionIndex) => h('div', {
              key: `${sectionIndex}:${section.name}`,
              className: 'dss__section',
            },
              h('div', { className: 'dss__sectionHead' },
                section.color === null ? null : h('span', {
                  className: 'dss__colorDot',
                  style: { background: section.color },
                }),
                h('span', { className: 'dss__sectionTitle' }, section.name),
                h('span', { className: 'dss__sectionCount' }, section.skills.length),
              ),
              h('div', { className: 'dss__table', role: 'table' },
                section.skills.map((entry, index) => {
                  const open = openSkill === entry.name;
                  return h('div', {
                    key: entry.name,
                    className: 'dss__row dss__row--skill',
                    'data-tone': index % 2 === 0 ? 'light' : 'deep',
                    'data-open': open ? 'true' : undefined,
                    role: 'row',
                    tabIndex: 0,
                    'aria-expanded': open,
                    onClick: () => {
                      // Selecting text inside the row must not also toggle it.
                      if ((window.getSelection?.()?.toString() ?? '') === '') toggleSkill(entry.name);
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleSkill(entry.name);
                      }
                    },
                  },
                    h('span', { className: 'dss__nameCell' },
                      h('span', { className: 'dss__skillName', title: entry.name }, entry.name),
                      h('span', { className: 'dss__skillCount' }, fill(t('group.callCount'), { n: entry.count ?? 0 }))),
                    h('span', {
                      className: 'dss__created',
                      title: dateTimeText(entry.createdAt) ?? '',
                    }, dateText(entry.createdAt) ?? (entry.source === 'bundled' ? t('skills.builtin') : '—')),
                    h('span', { className: 'dss__desc' }, entry.description || '—'),
                  );
                }),
              ),
            )),
            h('div', { className: 'dss__zeroNote' }, t('skills.note')),
          );
      } else if (view.level === 'days') {
        body = days.length === 0
          ? h('div', { className: 'dss__empty' }, scanning
            ? t('status.scanning')
            : (scan?.error ? t('empty.error') : t('empty')))
          : h('div', { className: 'dss__table', role: 'table' },
            h('div', { className: 'dss__row dss__row--head dss__row--dayHead', role: 'row' },
              h('span', null, t('table.date')),
              h('span', { className: 'dss__num' }, t('table.calls')),
              h('span', { className: 'dss__num' }, t('table.sessions')),
              h('span', { className: 'dss__spread' }, t('table.spread')),
            ),
            days.map((day, index) => h('div', {
              key: day.date,
              className: 'dss__row dss__row--day',
              'data-tone': index % 2 === 0 ? 'light' : 'deep',
              'data-today': day.date === today ? 'true' : undefined,
              role: 'row',
              tabIndex: 0,
              onClick: () => setView({ level: 'sessions', date: day.date }),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') setView({ level: 'sessions', date: day.date });
              },
            },
              h('span', { className: 'dss__date', title: day.date }, day.date),
              h('span', { className: 'dss__num' }, day.calls),
              h('span', { className: 'dss__num' }, day.sessions.length),
              h('span', { className: 'dss__spread' }, spreadNode(
                day.sessions.reduce((acc, session) => {
                  for (const [skill, value] of Object.entries(session.bySkill)) {
                    acc[skill] = (acc[skill] ?? 0) + value;
                  }
                  return acc;
                }, {}),
                4,
              )),
            )),
          );
      } else if (view.level === 'sessions' || openSession === null) {
        body = openDay === null
          ? h('div', { className: 'dss__empty' }, t('empty'))
          : h(React.Fragment, null,
            h('button', { className: 'dss__back', onClick: () => setView({ level: 'days' }) }, `← ${t('back')}`),
            h('div', { className: 'dss__subtitle' },
              fill(t('day.title'), {
                date: openDay.date,
                calls: openDay.calls,
                sessions: openDay.sessions.length,
              })),
            h('div', { className: 'dss__table', role: 'table' },
              h('div', { className: 'dss__row dss__row--head dss__row--session', role: 'row' },
                h('span', null, t('table.session')),
                h('span', null, t('table.spread')),
                h('span', { className: 'dss__num' }, t('table.calls')),
              ),
              openDay.sessions.map((session, index) => h('div', {
                key: session.id,
                className: 'dss__row dss__row--session',
                'data-tone': index % 2 === 0 ? 'light' : 'deep',
                role: 'row',
                tabIndex: 0,
                onClick: () => setView({ level: 'detail', date: openDay.date, id: session.id }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    setView({ level: 'detail', date: openDay.date, id: session.id });
                  }
                },
              },
                h('span', { className: 'dss__name', title: session.title ?? session.id },
                  session.title ?? shortId(session.id),
                  session.depth > 0 ? h('span', { className: 'dss__badge' }, t('detail.subagent')) : null,
                  session.archived ? h('span', { className: 'dss__badge' }, t('detail.archived')) : null,
                  session.workspace === '' ? null : h('span', { className: 'dss__ws' }, session.workspace),
                ),
                h('span', { className: 'dss__spread' }, spreadNode(session.bySkill, 4)),
                h('span', { className: 'dss__num' }, session.calls),
              )),
            ),
          );
      } else {
        const archived = openSession.archived === true;
        body = h(React.Fragment, null,
          h('button', {
            className: 'dss__back',
            onClick: () => setView({ level: 'sessions', date: view.date }),
          }, `← ${openDay?.date ?? ''}`),
          h('div', { className: 'dss__detail' },
            h('div', { className: 'dss__detailTitle' }, openSession.title ?? shortId(openSession.id)),
            h('div', { className: 'dss__cwd' }, openSession.cwd || '—'),
            h('div', { className: 'dss__kv' },
              h('span', null, `${t('detail.calls')} `, h('b', null, openSession.calls)),
              h('span', null, `${t('detail.turns')} `, h('b', null, openSession.turns ?? 0)),
              h('span', null, `${t('detail.first')} `, h('b', null, timeText(openSession.first))),
              h('span', null, `${t('detail.last')} `, h('b', null, timeText(openSession.last))),
              h('span', null, `${t('detail.cwd')} `, h('b', null, openSession.workspace || '—')),
            ),
            h('div', { className: 'dss__rows' },
              Object.entries(openSession.bySkill)
                .sort((a, b) => b[1] - a[1])
                .map(([skill, count]) => h('div', { className: 'dss__skillRow', key: skill },
                  h('span', null, skill),
                  h('span', { className: 'dss__skillCount' }, count),
                )),
            ),
            h('div', { className: 'dss__actions' },
              h('button', {
                className: 'dss__btn',
                onClick: () => { void copyId(openSession.id); },
              }, copied ? t('detail.copied') : t('detail.copy')),
              h('button', {
                className: 'dss__btn',
                onClick: () => { void copyId(openSession.cwd || openSession.id); },
              }, t('detail.copyPath')),
            ),
            h('div', { className: 'dss__hint', style: { marginTop: '10px', marginBottom: 0 } },
              archived ? t('detail.archivedNote') : t('detail.readOnlyNote')),
          ),
        );
      }

      return h(React.Fragment, null,
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'panel', className: 'dss', ref: pageRef },
          h('div', {
            className: 'dss__page',
            style: pageWidth === null ? undefined : { maxWidth: `${pageWidth}px` },
          },
            h('div', { className: 'dss__head' },
              inSkills ? h('button', {
                className: 'dss__back',
                onClick: () => setView({ level: 'days' }),
              }, `← ${t('back')}`) : null,
              h('span', { className: 'dss__title' }, inSkills ? t('skills.title') : t('title')),
              inSkills ? null : h('button', {
                className: 'dss__navBtn',
                onClick: () => setView({ level: 'skills' }),
              }, t('skills.button')),
            ),
            h('div', { className: 'dss__subtitle' },
              h('span', { className: 'dss__subtitleText' },
                h('span', { className: 'dss__dot', 'data-tone': tone, 'aria-hidden': true }),
                subtitleText,
              ),
              inSkills ? h('span', { className: 'dss__expandHint' }, t('skills.expandHint')) : null,
            ),
            scan?.error ? h('div', { className: 'dss__banner', role: 'alert' },
              t(scan.error === 'zstd-unavailable' ? 'scan.zstd' : 'scan.unreadable')) : null,
            inSkills ? null : h('div', { className: 'dss__bar' }, chips),
            body,
            view.level !== 'days' || zeroSkills.length === 0 ? null : h('div', { className: 'dss__zero' },
              h('div', { className: 'dss__zeroTitle' }, t('obs.title')),
              h('div', { className: 'dss__zeroList' }, zeroSkills.join(', ')),
              h('div', { className: 'dss__zeroNote' }, t('obs.note')),
            ),
          ),
        ),
        editing ? h(GroupsEditor, {
          key: 'editor',
          t,
          groups,
          colors: groupColors,
          skills: snapshot?.skills ?? [],
          saving: library.saving,
          error: library.error,
          onClose: () => setEditing(false),
          onSave: library.save,
        }) : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en: DICT.en, zh: DICT.zh }),
          'skill-history: dictionaries',
        );
        const t = ctx.locale.bind(NS);
        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => t('title'),
          }, PanelIcon)),
          'skill-history: sidebar icon',
        );
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, Panel)),
          'skill-history: main panel',
        );
      },
    };
  },
});
