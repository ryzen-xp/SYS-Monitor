// ESM imports (GNOME 45+)
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

// ── Helpers: read /proc and /sys files (async) ─────────────────────────────

async function readFileAsync(path) {
    const file = Gio.File.new_for_path(path);
    try {
        const [data] = await file.load_contents_async(null);
        return new TextDecoder().decode(data);
    } catch {
        return null;
    }
}

function readFileSync(path) {
    try {
        const [ok, data] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(data);
    } catch {
        return null;
    }
}

async function runCommand(argv) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return stdout?.trim() ?? null;
    } catch {
        return null;
    }
}

// ── CPU usage ───────────────────────────────────────────────────────────────

let _prevCpu = null;
async function getCpuPercent() {
    const raw = await readFileAsync('/proc/stat');
    if (!raw)
        return 0;

    const line = raw.split('\n')[0];
    const vals = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = vals[3] + vals[4];
    const total = vals.reduce((a, b) => a + b, 0);

    if (_prevCpu === null) {
        _prevCpu = {idle, total};
        return 0;
    }

    const dIdle = idle - _prevCpu.idle;
    const dTotal = total - _prevCpu.total;
    _prevCpu = {idle, total};
    return dTotal === 0 ? 0 : Math.round((1 - dIdle / dTotal) * 100);
}

// ── Memory ───────────────────────────────────────────────────────────────────

async function getMemInfo() {
    const raw = await readFileAsync('/proc/meminfo');
    if (!raw)
        return {ramPct: 0, swapPct: 0, ramUsedMB: 0, ramTotalMB: 0, swapUsedMB: 0, swapTotalMB: 0};

    const get = key => {
        const m = raw.match(new RegExp(key + ':\\s+(\\d+)'));
        return m ? parseInt(m[1]) : 0;
    };

    const total = get('MemTotal');
    const available = get('MemAvailable');
    const free = get('MemFree');
    const buffers = get('Buffers');
    const cached = get('Cached');
    const swapTotal = get('SwapTotal');
    const swapFree = get('SwapFree');
    const fallbackUsed = total - free - buffers - cached;
    const used = Math.max(0, available ? total - available : fallbackUsed);
    const swapUsed = Math.max(0, swapTotal - swapFree);

    return {
        ramPct: total ? Math.round(used / total * 100) : 0,
        swapPct: swapTotal ? Math.round(swapUsed / swapTotal * 100) : 0,
        ramUsedMB: Math.round(used / 1024),
        ramTotalMB: Math.round(total / 1024),
        swapUsedMB: Math.round(swapUsed / 1024),
        swapTotalMB: Math.round(swapTotal / 1024),
    };
}

// ── Network speed ──────────────────────────────────────────────────────────

let _prevNet = null;
async function getNetSpeed() {
    const raw = await readFileAsync('/proc/net/dev');
    if (!raw)
        return {upKB: 0, downKB: 0};

    let rxBytes = 0;
    let txBytes = 0;

    raw.split('\n').slice(2).forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10)
            return;
        const name = parts[0].replace(':', '');
        if (name === 'lo')
            return;
        rxBytes += parseInt(parts[1]);
        txBytes += parseInt(parts[9]);
    });

    const now = GLib.get_monotonic_time() / 1e6;
    if (_prevNet === null) {
        _prevNet = {rxBytes, txBytes, ts: now};
        return {upKB: 0, downKB: 0};
    }

    const dt = now - _prevNet.ts;
    const upKB = dt > 0 ? Math.round((txBytes - _prevNet.txBytes) / dt / 1024) : 0;
    const downKB = dt > 0 ? Math.round((rxBytes - _prevNet.rxBytes) / dt / 1024) : 0;
    _prevNet = {rxBytes, txBytes, ts: now};

    return {upKB: Math.max(0, upKB), downKB: Math.max(0, downKB)};
}

// ── SSD / disk speed + model ─────────────────────────────────────────────────

let _diskDevice = null;      // e.g. "nvme0n1"
let _diskModelShort = 'Disk';
let _diskSectorBytes = 512;
let _prevDisk = null;

function discoverDisk() {
    _diskDevice = null;
    _diskModelShort = 'Disk';

    // Prefer an NVMe device, else the first non-removable, non-loop block device.
    const candidates = [];
    try {
        const base = Gio.File.new_for_path('/sys/block');
        const en = base.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const name = info.get_name();
            if (name.startsWith('loop') || name.startsWith('ram') || name.startsWith('zram'))
                continue;
            const removable = (readFileSync(`/sys/block/${name}/removable`) ?? '0').trim();
            if (removable === '1')
                continue;
            candidates.push(name);
        }
        en.close(null);
    } catch {
        // ignore
    }

    const nvme = candidates.find(n => n.startsWith('nvme'));
    _diskDevice = nvme ?? candidates[0] ?? null;
    if (!_diskDevice)
        return;

    // Logical sector size for byte conversion.
    const ss = readFileSync(`/sys/block/${_diskDevice}/queue/logical_block_size`);
    _diskSectorBytes = ss ? parseInt(ss.trim()) || 512 : 512;

    // Model string lives in different places for nvme vs sata.
    let model = readFileSync(`/sys/block/${_diskDevice}/device/model`)
        ?? readFileSync(`/sys/class/nvme/${_diskDevice.replace(/n\d+$/, '')}/model`);
    _diskModelShort = shortenDiskModel(model);
}

function shortenDiskModel(model) {
    if (!model)
        return 'Disk';
    const m = model.trim().toUpperCase();
    const brands = [
        ['SAMSUNG', 'Samsung'], ['WD', 'WD'], ['WESTERN DIGITAL', 'WD'],
        ['SEAGATE', 'Seagate'], ['ST', 'Seagate'], ['CRUCIAL', 'Crucial'],
        ['KINGSTON', 'Kingston'], ['SANDISK', 'SanDisk'], ['INTEL', 'Intel'],
        ['SK HYNIX', 'SK Hynix'], ['HYNIX', 'SK Hynix'], ['MICRON', 'Micron'],
        ['TOSHIBA', 'Toshiba'], ['KIOXIA', 'Kioxia'], ['ADATA', 'ADATA'],
        ['CORSAIR', 'Corsair'], ['PNY', 'PNY'], ['GIGABYTE', 'Gigabyte'],
    ];
    for (const [needle, label] of brands) {
        if (m.includes(needle))
            return label;
    }
    // Fallback: first token, capped.
    return model.trim().split(/\s+/)[0].slice(0, 10);
}

async function getDiskSpeed() {
    if (!_diskDevice)
        return {readKB: 0, writeKB: 0};

    const raw = await readFileAsync('/proc/diskstats');
    if (!raw)
        return {readKB: 0, writeKB: 0};

    let line = null;
    for (const l of raw.split('\n')) {
        const parts = l.trim().split(/\s+/);
        if (parts[2] === _diskDevice) {
            line = parts;
            break;
        }
    }
    if (!line)
        return {readKB: 0, writeKB: 0};

    // Field 6 (index 5) = sectors read, field 10 (index 9) = sectors written.
    const sectorsRead = parseInt(line[5]) || 0;
    const sectorsWritten = parseInt(line[9]) || 0;
    const now = GLib.get_monotonic_time() / 1e6;

    if (_prevDisk === null) {
        _prevDisk = {sectorsRead, sectorsWritten, ts: now};
        return {readKB: 0, writeKB: 0};
    }

    const dt = now - _prevDisk.ts;
    const bps = _diskSectorBytes;
    const readKB = dt > 0 ? Math.round((sectorsRead - _prevDisk.sectorsRead) * bps / dt / 1024) : 0;
    const writeKB = dt > 0 ? Math.round((sectorsWritten - _prevDisk.sectorsWritten) * bps / dt / 1024) : 0;
    _prevDisk = {sectorsRead, sectorsWritten, ts: now};

    return {readKB: Math.max(0, readKB), writeKB: Math.max(0, writeKB)};
}

// ── GPU usage + type ─────────────────────────────────────────────────────────

let _gpuType = 'none';   // 'nvidia' | 'amd' | 'none'
let _amdBusyPath = null;

async function detectGpu() {
    if (GLib.find_program_in_path('nvidia-smi')) {
        // Confirm it actually responds.
        const out = await runCommand(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader']);
        if (out) {
            _gpuType = 'nvidia';
            return;
        }
    }

    for (const card of ['card0', 'card1', 'card2']) {
        const p = `/sys/class/drm/${card}/device/gpu_busy_percent`;
        if (Gio.File.new_for_path(p).query_exists(null)) {
            _gpuType = 'amd';
            _amdBusyPath = p;
            return;
        }
    }

    _gpuType = 'none';
}

async function getGpuStats() {
    // Returns {pct, temp} or {pct:null, temp:null}
    if (_gpuType === 'nvidia') {
        const out = await runCommand([
            'nvidia-smi',
            '--query-gpu=utilization.gpu,temperature.gpu',
            '--format=csv,noheader,nounits',
        ]);
        if (!out)
            return {pct: null, temp: null};
        const [u, t] = out.split('\n')[0].split(',').map(s => parseInt(s.trim()));
        return {
            pct: Number.isFinite(u) ? u : null,
            temp: Number.isFinite(t) ? t : null,
        };
    }

    if (_gpuType === 'amd') {
        const busy = _amdBusyPath ? await readFileAsync(_amdBusyPath) : null;
        const pct = busy ? parseInt(busy.trim()) : null;
        const temp = await _readTemperature(_gpuTempPath);
        return {pct: Number.isFinite(pct) ? pct : null, temp};
    }

    return {pct: null, temp: null};
}

// ── Temperature sensors (hwmon / thermal) ────────────────────────────────────

let _cpuTempPath = null;
let _gpuTempPath = null;   // only used for AMD; NVIDIA temp comes from nvidia-smi
let _ssdTempPath = null;
let _ramTempPath = null;

const CPU_HWMON_NAMES = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'];
const CPU_THERMAL_TYPES = ['x86_pkg_temp', 'TCPU', 'acpitz'];
const GPU_HWMON_NAMES = ['amdgpu'];
const SSD_HWMON_NAMES = ['nvme', 'drivetemp'];
const RAM_HWMON_NAMES = ['jc42', 'spd5118'];

function enumerateHwmon() {
    const result = [];
    try {
        const base = Gio.File.new_for_path('/sys/class/hwmon');
        const en = base.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const dir = info.get_name();
            const path = `/sys/class/hwmon/${dir}`;
            const name = (readFileSync(`${path}/name`) ?? '').trim();
            result.push({path, name});
        }
        en.close(null);
    } catch {
        // ignore
    }
    return result;
}

function findHwmonTemp(hwmonPath, labelRegex) {
    for (let i = 1; i <= 32; i++) {
        const input = `${hwmonPath}/temp${i}_input`;
        if (!Gio.File.new_for_path(input).query_exists(null))
            continue;
        const label = (readFileSync(`${hwmonPath}/temp${i}_label`) ?? '').trim();
        if (labelRegex && labelRegex.test(label))
            return input;
    }
    const first = `${hwmonPath}/temp1_input`;
    return Gio.File.new_for_path(first).query_exists(null) ? first : null;
}

function discoverTempSensors() {
    _cpuTempPath = _gpuTempPath = _ssdTempPath = _ramTempPath = null;
    const sensors = enumerateHwmon();

    // CPU: prefer a package label.
    for (const s of sensors) {
        if (CPU_HWMON_NAMES.includes(s.name)) {
            _cpuTempPath = findHwmonTemp(s.path, /package|tdie|tctl/i);
            break;
        }
    }
    if (!_cpuTempPath) {
        // Thermal-zone fallback.
        try {
            const base = Gio.File.new_for_path('/sys/class/thermal');
            const en = base.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                const zone = info.get_name();
                const type = (readFileSync(`/sys/class/thermal/${zone}/type`) ?? '').trim();
                if (CPU_THERMAL_TYPES.includes(type)) {
                    const f = `/sys/class/thermal/${zone}/temp`;
                    if (Gio.File.new_for_path(f).query_exists(null)) {
                        _cpuTempPath = f;
                        break;
                    }
                }
            }
            en.close(null);
        } catch {
            // ignore
        }
    }

    // GPU (AMD only via hwmon).
    for (const s of sensors) {
        if (GPU_HWMON_NAMES.some(n => s.name.includes(n))) {
            _gpuTempPath = findHwmonTemp(s.path, /edge|junction/i);
            break;
        }
    }

    // SSD (NVMe composite preferred).
    for (const s of sensors) {
        if (SSD_HWMON_NAMES.some(n => s.name.includes(n))) {
            _ssdTempPath = findHwmonTemp(s.path, /composite/i);
            break;
        }
    }

    // RAM (rarely present).
    for (const s of sensors) {
        if (RAM_HWMON_NAMES.some(n => s.name.includes(n))) {
            _ramTempPath = findHwmonTemp(s.path, null);
            break;
        }
    }
}

async function _readTemperature(sensorPath) {
    if (!sensorPath)
        return null;
    const raw = await readFileAsync(sensorPath);
    if (!raw)
        return null;
    const milliC = parseInt(raw.trim(), 10);
    if (!Number.isFinite(milliC) || milliC <= 0)
        return null;
    return Math.round(milliC / 1000);
}

async function getCpuTemperature() {
    return _readTemperature(_cpuTempPath);
}

async function getSsdTemperature() {
    return _readTemperature(_ssdTempPath);
}

async function getRamTemperature() {
    return _readTemperature(_ramTempPath);
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatSpeed(kb) {
    if (kb >= 1024)
        return `${(kb / 1024).toFixed(1)}M`;
    return `${kb}K`;
}

function splitSpeed(kb) {
    if (kb >= 1024)
        return {val: (kb / 1024).toFixed(1), unit: 'MB/s'};
    return {val: kb.toString(), unit: 'KB/s'};
}

function formatMemory(mb) {
    if (mb >= 1024)
        return `${(mb / 1024).toFixed(1)} GiB`;
    return `${mb} MiB`;
}

function gpuTypeLabel() {
    if (_gpuType === 'nvidia')
        return 'NVIDIA';
    if (_gpuType === 'amd')
        return 'AMD';
    return 'GPU';
}

function tempText(t) {
    return t === null || t === undefined ? 'N/A' : `${t}°C`;
}

// ── Threshold colors ─────────────────────────────────────────────────────────

const THRESHOLD_STATES = [
    {max: 59, className: 'color-normal'},
    {max: 79, className: 'color-warning'},
    {max: 100, className: 'color-critical'},
];
const MONOCHROME_STATE = {className: 'color-monochrome', color: '#deddda'};

function usageState(pct) {
    const p = Math.max(0, Math.min(100, pct ?? 0));
    return THRESHOLD_STATES.find(s => p <= s.max) ?? THRESHOLD_STATES[2];
}

function tempState(celsius) {
    if (celsius === null || celsius === undefined)
        return {className: 'color-normal', color: '#8bd889'};
    if (celsius < 55)
        return {className: 'color-temp-cool', color: '#67c2ba'};
    if (celsius < 75)
        return {className: 'color-temp-warm', color: '#f4b24d'};
    return {className: 'color-temp-hot', color: '#ff6b6b'};
}

// ── Drawing helpers (sparkline / wave) ───────────────────────────────────────

const CHART_POINTS = 28;

const METRIC_THEMES = {
    cpu: {color: '#34d399', icon: 'cpu', tone: 'cpu'},
    gpu: {color: '#c084fc', icon: 'gpu', tone: 'gpu'},
    ram: {color: '#a78bfa', icon: 'ram', tone: 'ram'},
    swap: {color: '#facc15', icon: 'swap', tone: 'swap'},
    ssd: {color: '#ffb366', icon: 'download', tone: 'ssd'},
};

const THEME_ICON_FALLBACK = {
    cpu: 'processor-symbolic',
    ram: 'memory-symbolic',
    swap: 'media-swap-symbolic',
    gpu: 'video-display-symbolic',
    upload: 'go-up-symbolic',
    download: 'go-down-symbolic',
};

function makePanelIcon(ext, iconName, colorClass, sizePx) {
    const icon = new St.Icon({
        style_class: `sysmon-panel-icon ${colorClass}`,
        icon_size: sizePx,
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (ext.path) {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([ext.path, 'icons', `${iconName}-symbolic.svg`]));
        if (file.query_exists(null))
            icon.gicon = new Gio.FileIcon({file});
        else if (THEME_ICON_FALLBACK[iconName])
            icon.icon_name = THEME_ICON_FALLBACK[iconName];
        else
            icon.icon_name = 'utilities-system-monitor-symbolic';
    } else {
        icon.icon_name = THEME_ICON_FALLBACK[iconName] ?? 'utilities-system-monitor-symbolic';
    }
    return icon;
}

function makeIconBadge(ext, iconName, tone, size = 'metric') {
    const isMetric = size === 'metric';
    const wrapPx = isMetric ? 40 : 28;
    const iconPx = isMetric ? 22 : 16;
    const wrapClass = isMetric ? 'sysmon-metric-icon-wrap' : 'sysmon-net-icon-wrap';
    const iconClass = isMetric ? 'sysmon-metric-icon' : 'sysmon-net-icon';

    const wrap = new St.Widget({
        style_class: `${wrapClass} tone-${tone}`,
        width: wrapPx,
        height: wrapPx,
        y_align: Clutter.ActorAlign.CENTER,
    });
    wrap.set_layout_manager(new Clutter.BinLayout());

    const icon = new St.Icon({
        style_class: `${iconClass} tone-${tone}`,
        icon_size: iconPx,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });

    let loaded = false;
    if (iconName && ext.path) {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([ext.path, 'icons', `${iconName}-symbolic.svg`]));
        if (file.query_exists(null)) {
            icon.gicon = new Gio.FileIcon({file});
            loaded = true;
        }
    }
    if (!loaded && iconName && THEME_ICON_FALLBACK[iconName])
        icon.icon_name = THEME_ICON_FALLBACK[iconName];

    wrap.add_child(icon);
    return wrap;
}

function rgbaFromHex(hex, alpha = 1) {
    const clean = hex.replace('#', '');
    return [
        parseInt(clean.slice(0, 2), 16) / 255,
        parseInt(clean.slice(2, 4), 16) / 255,
        parseInt(clean.slice(4, 6), 16) / 255,
        alpha,
    ];
}

function pushChartHistory(canvas, value) {
    canvas._history.push(Math.max(0, value ?? 0));
    while (canvas._history.length > canvas._maxPoints)
        canvas._history.shift();
    canvas.queue_repaint?.();
}

function makeSparkline(color, width = 108, height = 30) {
    const canvas = new St.DrawingArea({width, height, x_align: Clutter.ActorAlign.END});
    canvas._history = [];
    canvas._color = color;
    canvas._maxPoints = CHART_POINTS;
    canvas.connect('repaint', area => {
        const cr = area.get_context();
        const history = canvas._history;
        if (history.length < 2) {
            cr.$dispose();
            return;
        }
        const max = Math.max(...history, 1);
        const offset = canvas._maxPoints - history.length;
        const step = width / (canvas._maxPoints - 1);
        const [r, g, b] = rgbaFromHex(canvas._color);
        cr.moveTo(offset * step, height - (history[0] / max) * (height - 6) - 3);
        for (let i = 1; i < history.length; i++) {
            const x = (offset + i) * step;
            const y = height - (history[i] / max) * (height - 6) - 3;
            cr.lineTo(x, y);
        }
        cr.setSourceRGBA(r, g, b, 0.92);
        cr.setLineWidth(1.6);
        cr.stroke();
        cr.$dispose();
    });
    return canvas;
}

function makeWaveChart(color, height = 52) {
    const canvas = new St.DrawingArea({height, x_expand: true});
    canvas._history = [];
    canvas._color = color;
    canvas._maxPoints = CHART_POINTS;
    canvas.connect('repaint', area => {
        const cr = area.get_context();
        const history = canvas._history;
        const width = area.get_width() || 148;
        if (history.length < 2) {
            cr.$dispose();
            return;
        }
        const max = Math.max(...history, 1);
        const offset = canvas._maxPoints - history.length;
        const step = width / (canvas._maxPoints - 1);
        const [r, g, b] = rgbaFromHex(canvas._color);
        const yAt = i => height - (history[i] / max) * (height - 10) - 5;
        const xAt = i => (offset + i) * step;
        cr.moveTo(xAt(0), height);
        cr.lineTo(xAt(0), yAt(0));
        for (let i = 1; i < history.length; i++)
            cr.lineTo(xAt(i), yAt(i));
        cr.lineTo(xAt(history.length - 1), height);
        cr.closePath();
        cr.setSourceRGBA(r, g, b, 0.28);
        cr.fill();
        cr.moveTo(xAt(0), yAt(0));
        for (let i = 1; i < history.length; i++)
            cr.lineTo(xAt(i), yAt(i));
        cr.setSourceRGBA(r, g, b, 0.88);
        cr.setLineWidth(1.5);
        cr.stroke();
        cr.$dispose();
    });
    return canvas;
}

// ── Panel Indicator ────────────────────────────────────────────────────────

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'System Monitor');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._lastData = null;

        const watchKeys = [
            'monochrome-mode', 'panel-font-size',
            'bar-cpu', 'bar-gpu', 'bar-ram', 'bar-swap', 'bar-temp', 'bar-net', 'bar-ssd-speed',
            'net-merged',
        ];
        this._settingsChangedIds = watchKeys.map(key =>
            this._settings.connect(`changed::${key}`, () => this._rebuildPanel()));

        this._panelBox = new St.BoxLayout({
            style_class: 'sysmon-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._buildPopup();
        this.menu.actor.add_style_class_name('sysmon-popup-menu');
        this.menu.actor.set_width(360);

        this._buildPanel();
    }

    // Build the panel bar from the current settings. Each visible item is a
    // small group with its own icon + value label. Called on every settings
    // change so the bar is fully customizable at runtime.
    _buildPanel() {
        this._panelBox.destroy_all_children();
        this._panelItems = {};

        const font = this._settings.get_int('panel-font-size');
        const iconPx = Math.max(10, Math.round(font + 2));

        const order = [
            ['bar-cpu', 'cpu', 'cpu'],
            ['bar-gpu', 'gpu', 'gpu'],
            ['bar-ram', 'ram', 'ram'],
            ['bar-swap', 'swap', 'swap'],
            ['bar-temp', 'temp', 'cpu'],
            ['bar-ssd-speed', 'ssd', 'download'],
            ['bar-net', 'net', 'download'],
        ];

        let first = true;
        for (const [key, id, iconName] of order) {
            if (!this._settings.get_boolean(key))
                continue;

            if (!first)
                this._panelBox.add_child(this._makeSep(font));
            first = false;

            const group = new St.BoxLayout({
                style_class: 'sysmon-panel-metric',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const icon = makePanelIcon(this._ext, iconName, 'color-normal', iconPx);
            const value = new St.Label({
                style_class: 'sysmon-panel-value color-normal',
                y_align: Clutter.ActorAlign.CENTER,
            });
            value.style = `font-size: ${font}px;`;
            group.add_child(icon);
            group.add_child(value);
            this._panelBox.add_child(group);
            this._panelItems[id] = {group, icon, value};
        }

        if (this._lastData)
            this._refreshPanel(this._lastData);
    }

    _rebuildPanel() {
        this._buildPanel();
        this._syncPopupVisibility();
        if (this._lastData)
            this._refreshPopup(this._lastData);
    }

    _makeSep(font) {
        const label = new St.Label({
            text: '|',
            style_class: 'sysmon-panel-sep',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.style = `font-size: ${Math.round(font * 0.85)}px;`;
        return label;
    }

    _buildPopup() {
        const titleItem = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: 'sysmon-popup-item'});
        const header = new St.BoxLayout({style_class: 'sysmon-popup-header', x_expand: true});
        header.add_child(new St.Label({
            text: 'System Monitor',
            style_class: 'sysmon-popup-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const prefsBtn = new St.Button({
            style_class: 'sysmon-header-btn',
            child: new St.Icon({icon_name: 'open-menu-symbolic', style_class: 'sysmon-header-icon'}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        prefsBtn.connect('clicked', () => {
            this.menu.close();
            this._ext.openPreferences?.();
        });
        header.add_child(prefsBtn);
        titleItem.add_child(header);
        this.menu.addMenuItem(titleItem);

        this._cpuItem = this._makeMetricCard('cpu', 'CPU', 'Processor load', true);
        this.menu.addMenuItem(this._cpuItem.item);

        this._gpuItem = this._makeMetricCard('gpu', 'GPU', 'Graphics load', true);
        this.menu.addMenuItem(this._gpuItem.item);

        this._ramItem = this._makeMetricCard('ram', 'RAM', 'Memory in use', true);
        this.menu.addMenuItem(this._ramItem.item);

        this._ssdItem = this._makeMetricCard('ssd', 'SSD', 'Storage', true);
        this.menu.addMenuItem(this._ssdItem.item);

        this._swapItem = this._makeMetricCard('swap', 'Swap', 'Swap in use', false);
        this.menu.addMenuItem(this._swapItem.item);

        const netItem = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: 'sysmon-popup-item'});
        const netGrid = new St.BoxLayout({style_class: 'sysmon-net-grid', x_expand: true});
        this._upCard = this._makeNetCard('Upload', 'upload', '#34d399', 'up');
        this._downCard = this._makeNetCard('Download', 'download', '#60a5fa', 'down');
        netGrid.add_child(this._upCard.box);
        netGrid.add_child(this._downCard.box);
        netItem.add_child(netGrid);
        this.menu.addMenuItem(netItem);
        this._netItem = netItem;
    }

    _makeMetricCard(metricId, title, detail, withTemp) {
        const theme = METRIC_THEMES[metricId];
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, style_class: 'sysmon-popup-item'});
        const card = new St.BoxLayout({vertical: false, x_expand: true, style_class: 'sysmon-metric-card'});

        const iconWrap = makeIconBadge(this._ext, theme.icon, theme.tone, 'metric');

        const body = new St.BoxLayout({
            vertical: true, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'sysmon-metric-body',
        });
        body.add_child(new St.Label({text: title, style_class: 'sysmon-metric-title'}));
        const detailLbl = new St.Label({text: detail, style_class: 'sysmon-metric-detail'});
        body.add_child(detailLbl);

        const rightCol = new St.BoxLayout({
            vertical: true, x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'sysmon-metric-side',
        });
        const stats = new St.BoxLayout({
            vertical: false, x_align: Clutter.ActorAlign.END, style_class: 'sysmon-metric-stats',
        });

        let tempLbl = null;
        if (withTemp) {
            tempLbl = new St.Label({text: 'N/A', style_class: `sysmon-metric-temp tone-${theme.tone}`});
            stats.add_child(tempLbl);
        }
        const pctLbl = new St.Label({text: '', style_class: `sysmon-metric-pct tone-${theme.tone}`});
        stats.add_child(pctLbl);

        const sparkline = makeSparkline(theme.color);
        rightCol.add_child(stats);
        rightCol.add_child(sparkline);

        card.add_child(iconWrap);
        card.add_child(body);
        card.add_child(rightCol);
        item.add_child(card);

        return {item, detailLbl, pctLbl, tempLbl, sparkline, accentColor: theme.color, tone: theme.tone};
    }

    _makeNetCard(title, iconName, accentColor, tone) {
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'sysmon-net-card'});
        const top = new St.BoxLayout({vertical: false, style_class: 'sysmon-net-top'});
        top.add_child(makeIconBadge(this._ext, iconName, tone, 'net'));
        const titleLbl = new St.Label({text: title, style_class: 'sysmon-net-label'});
        top.add_child(titleLbl);
        const valRow = new St.BoxLayout({vertical: false, style_class: 'sysmon-net-value-row'});
        const val = new St.Label({text: '0', style_class: `sysmon-net-value tone-${tone}`});
        const unit = new St.Label({text: 'KB/s', style_class: 'sysmon-net-unit'});
        valRow.add_child(val);
        valRow.add_child(unit);
        const wave = makeWaveChart(accentColor);
        box.add_child(top);
        box.add_child(valRow);
        box.add_child(wave);
        return {box, val, unit, wave, titleLbl, accentColor};
    }

    // ── Updates ──────────────────────────────────────────────────────────

    update(data) {
        this._lastData = data;
        this._refreshPanel(data);
        this._refreshPopup(data);
    }

    _colorClass(stateClass) {
        return this._settings.get_boolean('monochrome-mode') ? MONOCHROME_STATE.className : stateClass;
    }

    _setPanel(id, text, stateClass) {
        const it = this._panelItems?.[id];
        if (!it)
            return;
        const cls = this._colorClass(stateClass);
        it.value.set_text(text);
        it.value.set_style_class_name(`sysmon-panel-value ${cls}`);
        it.value.style = `font-size: ${this._settings.get_int('panel-font-size')}px;`;
        it.icon.set_style_class_name(`sysmon-panel-icon ${cls}`);
    }

    _refreshPanel(data) {
        const {cpu, cpuTemp, gpu, gpuTemp, mem, net, disk} = data;

        this._setPanel('cpu', `${cpu}%`, usageState(cpu).className);

        if (gpu.pct !== null)
            this._setPanel('gpu', `${gpu.pct}%`, usageState(gpu.pct).className);
        else
            this._setPanel('gpu', 'N/A', 'color-normal');

        this._setPanel('ram', `${mem.ramPct}%`, usageState(mem.ramPct).className);
        this._setPanel('swap', `${mem.swapPct}%`, usageState(mem.swapPct).className);

        // CPU + GPU average temperature.
        const temps = [cpuTemp, gpuTemp].filter(t => t !== null && t !== undefined);
        if (temps.length > 0) {
            const avg = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length);
            this._setPanel('temp', `${avg}°C`, tempState(avg).className);
        } else {
            this._setPanel('temp', 'N/A', 'color-normal');
        }

        // SSD read/write speed.
        if (disk) {
            const txt = `${formatSpeed(disk.readKB)}/${formatSpeed(disk.writeKB)}`;
            this._setPanel('ssd', txt, 'color-normal');
        }

        // Network — merged or split, controlled by setting.
        if (net) {
            if (this._settings.get_boolean('net-merged')) {
                this._setPanel('net', formatSpeed(net.upKB + net.downKB), 'color-normal');
            } else {
                this._setPanel('net', `↓${formatSpeed(net.downKB)} ↑${formatSpeed(net.upKB)}`, 'color-normal');
            }
        }
    }

    _refreshPopup(data) {
        const {cpu, cpuTemp, gpu, gpuTemp, ssdTemp, ramTemp, mem, net, disk} = data;

        this._refreshMetricCard(this._cpuItem, cpu, cpuTemp, 'cpu');
        this._cpuItem.detailLbl.set_text('Processor load');

        if (gpu.pct !== null) {
            this._refreshMetricCard(this._gpuItem, gpu.pct, gpuTemp, 'gpu');
            this._gpuItem.detailLbl.set_text(`${gpuTypeLabel()} load`);
        } else {
            this._gpuItem.pctLbl.set_text('N/A');
            this._refreshTempLabel(this._gpuItem, gpuTemp, 'gpu');
            this._gpuItem.detailLbl.set_text('No active GPU');
        }

        this._refreshMetricCard(this._ramItem, mem.ramPct, ramTemp, 'ram');
        this._ramItem.detailLbl.set_text(`${formatMemory(mem.ramUsedMB)} / ${formatMemory(mem.ramTotalMB)}`);

        // SSD card: temp + model name, plus live read/write in the detail line.
        this._ssdItem.pctLbl.set_text('');
        this._refreshTempLabel(this._ssdItem, ssdTemp, 'ssd');
        if (disk) {
            this._ssdItem.detailLbl.set_text(
                `${_diskModelShort}  ·  R ${formatSpeed(disk.readKB)}B/s  W ${formatSpeed(disk.writeKB)}B/s`);
            pushChartHistory(this._ssdItem.sparkline, disk.readKB + disk.writeKB);
        } else {
            this._ssdItem.detailLbl.set_text(_diskModelShort);
        }

        this._refreshMetricCard(this._swapItem, mem.swapPct, null, 'swap');
        this._swapItem.detailLbl.set_text(mem.swapTotalMB > 0
            ? `${formatMemory(mem.swapUsedMB)} / ${formatMemory(mem.swapTotalMB)}`
            : 'No swap configured');

        if (net) {
            const merged = this._settings.get_boolean('net-merged');
            if (merged) {
                const total = net.upKB + net.downKB;
                const s = splitSpeed(total);
                this._upCard.titleLbl.set_text('Total');
                this._upCard.val.set_text(s.val);
                this._upCard.unit.set_text(s.unit);
                this._refreshNetCard(this._upCard, total);
                this._downCard.box.visible = false;
            } else {
                this._downCard.box.visible = true;
                this._upCard.titleLbl.set_text('Upload');
                const up = splitSpeed(net.upKB);
                const down = splitSpeed(net.downKB);
                this._upCard.val.set_text(up.val);
                this._upCard.unit.set_text(up.unit);
                this._downCard.val.set_text(down.val);
                this._downCard.unit.set_text(down.unit);
                this._refreshNetCard(this._upCard, net.upKB);
                this._refreshNetCard(this._downCard, net.downKB);
            }
        }

        this._syncPopupVisibility();
    }

    _refreshMetricCard(card, pct, temp, tone) {
        const mono = this._settings.get_boolean('monochrome-mode');
        const color = mono ? MONOCHROME_STATE.color : card.accentColor;
        const toneClass = mono ? 'tone-mono' : `tone-${tone}`;
        card.pctLbl.set_text(`${pct}%`);
        card.pctLbl.set_style_class_name(`sysmon-metric-pct ${toneClass}`);
        card.sparkline._color = color;
        pushChartHistory(card.sparkline, pct);
        if (card.tempLbl)
            this._refreshTempLabel(card, temp, tone);
    }

    _refreshTempLabel(card, temp, tone) {
        if (!card.tempLbl)
            return;
        card.tempLbl.set_text(tempText(temp));
        const mono = this._settings.get_boolean('monochrome-mode');
        if (mono) {
            card.tempLbl.set_style_class_name('sysmon-metric-temp tone-mono');
        } else if (temp === null || temp === undefined) {
            card.tempLbl.set_style_class_name(`sysmon-metric-temp tone-${tone}`);
        } else {
            card.tempLbl.set_style_class_name(`sysmon-metric-temp ${tempState(temp).className}`);
        }
    }

    _refreshNetCard(card, kb) {
        const mono = this._settings.get_boolean('monochrome-mode');
        card.wave._color = mono ? MONOCHROME_STATE.color : card.accentColor;
        pushChartHistory(card.wave, kb);
    }

    _syncPopupVisibility() {
        const hasGpu = this._lastData ? this._lastData.gpu.pct !== null : false;
        // Popup always shows CPU, RAM, SSD, Swap, Net. GPU hidden if none.
        this._gpuItem.item.visible = hasGpu || (this._lastData && this._lastData.gpuTemp !== null);
    }

    destroy() {
        for (const id of this._settingsChangedIds)
            this._settings.disconnect(id);
        this._settingsChangedIds = [];
        super.destroy();
    }
});

// ── Main Extension ─────────────────────────────────────────────────────────

export default class SysMonExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._timerId = null;
        this._settings = null;
        this._refreshChangedId = 0;
    }

    async enable() {
        this._settings = this.getSettings();
        this._refreshChangedId = this._settings.connect('changed::refresh-interval', () => {
            this._restartTimer();
            this._tick();
        });

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        discoverDisk();
        discoverTempSensors();
        await detectGpu();

        this._startTimer();
        this._tick();
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._startTimer();
    }

    _tick() {
        Promise.all([
            getCpuPercent(),
            getCpuTemperature(),
            getSsdTemperature(),
            getRamTemperature(),
            getMemInfo(),
            getNetSpeed(),
            getDiskSpeed(),
            getGpuStats(),
        ]).then(([cpu, cpuTemp, ssdTemp, ramTemp, mem, net, disk, gpu]) => {
            this._indicator?.update({
                cpu,
                cpuTemp,
                ssdTemp,
                ramTemp,
                mem,
                net,
                disk,
                gpu,
                gpuTemp: gpu.temp,
            });
        }).catch(e => console.error(`SysMon update failed: ${e}`));
    }

    disable() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        if (this._settings && this._refreshChangedId) {
            this._settings.disconnect(this._refreshChangedId);
            this._refreshChangedId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        _prevCpu = null;
        _prevNet = null;
        _prevDisk = null;
        _cpuTempPath = _gpuTempPath = _ssdTempPath = _ramTempPath = null;
    }
}
