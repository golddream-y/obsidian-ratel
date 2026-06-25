/**
 * @file src/ui/diagnostics/tab-bar.ts
 * @description 诊断页子 Tab 切换组件
 * @module ui/diagnostics/tab-bar
 * @depends obsidian
 */

/**
 * 子 Tab 定义。
 */
export interface DiagTab {
    id: string;
    label: string;
    icon?: string;
    render: (container: HTMLElement) => void;
}

/**
 * 创建子 Tab 栏,点击 Tab 时切换内容区。
 *
 * @param parent - 父容器(清空后渲染 Tab 栏 + 内容区)。
 * @param tabs - Tab 定义数组。
 * @param defaultId - 默认激活的 Tab id,默认第一个。
 */
export function createTabBar(
    parent: HTMLElement,
    tabs: DiagTab[],
    defaultId?: string,
): void {
    parent.empty();

    const tabBar = parent.createDiv({ cls: 'diag-tabs' });
    const contentArea = parent.createDiv({ cls: 'diag-tab-content' });

    let activeId = defaultId ?? tabs[0]?.id;

    const activateTab = (id: string) => {
        activeId = id;
        tabBar.querySelectorAll('.diag-tab').forEach((el) => {
            if ((el as HTMLElement).dataset.tabId === id) {
                el.addClass('diag-tab-active');
            } else {
                el.removeClass('diag-tab-active');
            }
        });
        contentArea.empty();
        const tab = tabs.find((t) => t.id === id);
        if (tab) {
            tab.render(contentArea);
        }
    };

    for (const tab of tabs) {
        const btn = tabBar.createEl('button', {
            cls: 'diag-tab' + (tab.id === activeId ? ' diag-tab-active' : ''),
            text: tab.label,
        });
        btn.dataset.tabId = tab.id;
        btn.addEventListener('click', () => activateTab(tab.id));
    }

    if (activeId) {
        activateTab(activeId);
    }
}
