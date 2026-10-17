// ESM preferences (GNOME 45+)
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SysMonPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(540, 640);

        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });

        // ── Panel bar: pick which items render ────────────────────────────
        const barGroup = new Adw.PreferencesGroup({
            title: _('Panel Bar'),
            description: _('Choose which items appear in the top bar. Everything stays visible in the popup dashboard.'),
        });

        const barToggles = [
            ['bar-cpu', _('CPU usage'), _('Show processor load percentage.')],
            ['bar-gpu', _('GPU usage'), _('Show graphics load percentage.')],
            ['bar-ram', _('RAM usage'), _('Show memory usage percentage.')],
            ['bar-swap', _('Swap usage'), _('Show swap usage percentage.')],
            ['bar-temp', _('CPU + GPU average temp'), _('Show the average of CPU and GPU temperature.')],
            ['bar-ssd-speed', _('SSD read/write speed'), _('Show live disk read and write throughput.')],
            ['bar-net', _('Network speed'), _('Show network throughput.')],
        ];
        for (const [key, title, subtitle] of barToggles) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            barGroup.add(row);
        }
        page.add(barGroup);

        // ── Network style ──────────────────────────────────────────────────
        const netGroup = new Adw.PreferencesGroup({title: _('Network')});
        const mergedRow = new Adw.SwitchRow({
            title: _('Merge upload + download'),
            subtitle: _('Show a single combined speed instead of separate up/down values.'),
        });
        settings.bind('net-merged', mergedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        netGroup.add(mergedRow);
        page.add(netGroup);

        // ── Appearance ───────────────────────────────────────────────────
        const appGroup = new Adw.PreferencesGroup({title: _('Appearance')});

        const fontRow = new Adw.SpinRow({
            title: _('Panel font size'),
            subtitle: _('Text size in pixels for items shown in the bar (8–20).'),
            adjustment: new Gtk.Adjustment({lower: 8, upper: 20, step_increment: 1, page_increment: 2}),
        });
        settings.bind('panel-font-size', fontRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(fontRow);

        const monoRow = new Adw.SwitchRow({
            title: _('Monochrome mode'),
            subtitle: _('Use one neutral color instead of status colors.'),
        });
        settings.bind('monochrome-mode', monoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(monoRow);
        page.add(appGroup);

        // ── Updates ──────────────────────────────────────────────────────
        const updGroup = new Adw.PreferencesGroup({title: _('Updates')});
        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval (seconds)'),
            subtitle: _('Lower values update faster and use slightly more CPU (1–10).'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1}),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        updGroup.add(intervalRow);
        page.add(updGroup);

        window.add(page);
    }
}
