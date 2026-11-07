/** Pure UI coordinates. Rectangles use the Canvas' centered local origin. */
export type LayoutRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type AxisScale = Readonly<{ x: number; y: number }>;
export type DesignSize = Readonly<{ width: number; height: number }>;
type Rects<K extends string> = Readonly<Record<K, LayoutRect>>;
export interface GameLayout {
    readonly landscape: boolean;
    readonly width: number;
    readonly height: number;
    readonly safe: Readonly<{ left: number; right: number; top: number; bottom: number; width: number; height: number; centerX: number; centerY: number }>;
    readonly cssScaleX: number;
    readonly cssScaleY: number;
    readonly minTargetWidth: number;
    readonly minTargetHeight: number;
    box(x: number, y: number, width: number, height: number): LayoutRect;
    target(x: number, y: number, width: number, height: number): LayoutRect;
    readonly menu: Rects<'title' | 'subtitle' | 'hint' | 'opponent' | 'start' | 'practice'> & {
        readonly cards: readonly LayoutRect[]; readonly portraits: readonly LayoutRect[];
        readonly names: readonly LayoutRect[]; readonly summaries: readonly LayoutRect[]; readonly modes: readonly LayoutRect[];
    };
    readonly intro: Rects<'title' | 'enter' | 'back'> & {
        readonly cards: readonly LayoutRect[]; readonly portraits: readonly LayoutRect[];
        readonly facets: readonly LayoutRect[]; readonly names: readonly LayoutRect[]; readonly stories: readonly LayoutRect[];
    };
    readonly battle: Rects<'pause' | 'timer' | 'guard' | 'attack' | 'status' | 'feedback' | 'hint' | 'retry'> & {
        readonly roles: readonly LayoutRect[]; readonly hp: readonly LayoutRect[]; readonly hpBars: readonly LayoutRect[];
    };
    readonly result: Rects<'title' | 'hp' | 'mode' | 'retry' | 'change'>;
    readonly common: Rects<'build' | 'title' | 'description' | 'role' | 'primary' | 'secondary' | 'tertiary' | 'back'>;
}

/** Cocos3.8.8 view._convertToUISpace: raw physical pixels to design UI. */
export function physicalSafeToUiRect(raw: LayoutRect, viewport: LayoutRect, scale: AxisScale): LayoutRect {
    positive(scale.x, 'scale.x'); positive(scale.y, 'scale.y');
    geometry(raw, 'raw safe rectangle'); geometry(viewport, 'viewport');
    return frozenRect((raw.x - viewport.x) / scale.x, (raw.y - viewport.y) / scale.y,
        raw.width / scale.x, raw.height / scale.y);
}

/** sys.getSafeAreaRect(false) is already UI space; do not divide it by scale again. */
export function layoutFromUiSafeRect(design: DesignSize, safeRect: LayoutRect, cssScale: AxisScale): GameLayout {
    positive(design.width, 'design width'); positive(design.height, 'design height');
    positive(cssScale.x, 'CSS scale.x'); positive(cssScale.y, 'CSS scale.y');
    geometry(safeRect, 'safe rectangle');
    const { width, height } = design, landscape = width > height;
    // SHOW_ALL may leave physical screen area outside the design content. Those
    // margins are not unsafe UI insets; intersect before changing the origin.
    const x0 = Math.max(0, safeRect.x), y0 = Math.max(0, safeRect.y);
    const x1 = Math.min(width, safeRect.x + safeRect.width), y1 = Math.min(height, safeRect.y + safeRect.height);
    if (x1 <= x0 || y1 <= y0) throw new Error('Safe rectangle does not intersect the design content');
    const safe = Object.freeze({ left: x0 - width / 2, right: x1 - width / 2,
        bottom: y0 - height / 2, top: y1 - height / 2, width: x1 - x0, height: y1 - y0,
        centerX: (x0 + x1 - width) / 2, centerY: (y0 + y1 - height) / 2 });
    const sx = safe.width / width, sy = safe.height / height;
    const minTargetWidth = 44 / cssScale.x, minTargetHeight = 44 / cssScale.y;
    const box = (x: number, y: number, w: number, h: number): LayoutRect => {
        geometry({ x, y, width: w, height: h }, 'UI rectangle');
        return frozenRect(safe.centerX + x * sx, safe.centerY + y * sy, w * sx, h * sy);
    };
    const target = (x: number, y: number, w: number, h: number): LayoutRect => {
        const rect = box(x, y, w, h);
        const targetW = Math.max(minTargetWidth, rect.width), targetH = Math.max(minTargetHeight, rect.height);
        if (targetW > safe.width || targetH > safe.height) throw new Error('Safe rectangle cannot contain the minimum touch target');
        return frozenRect(Math.min(safe.right - targetW / 2, Math.max(safe.left + targetW / 2, rect.x)),
            Math.min(safe.top - targetH / 2, Math.max(safe.bottom + targetH / 2, rect.y)), targetW, targetH);
    };
    const menuX = landscape ? [-400, 0, 400] : [-228, 0, 228];
    const menu = Object.freeze({
        title: box(0, landscape ? 310 : 558, 660, 80), subtitle: box(0, landscape ? 250 : 477, 660, 60),
        cards: frozenRects(menuX.map(x => target(x, landscape ? 58 : 224, landscape ? 376 : 212, landscape ? 304 : 416))),
        portraits: frozenRects(menuX.map(x => box(x, landscape ? 116 : 296, landscape ? 150 : 200, landscape ? 150 : 200))),
        names: frozenRects(menuX.map(x => box(x, landscape ? 22 : 168, landscape ? 352 : 200, 48))),
        summaries: frozenRects(menuX.map(x => box(x, landscape ? -43 : 88, landscape ? 352 : 188, landscape ? 84 : 112))),
        modes: frozenRects((landscape ? [-440, -64] : [-168, 168]).map(x => target(x, landscape ? -155 : -52, landscape ? 352 : 312, 96))),
        hint: box(0, -146, 640, 72),
        opponent: target(landscape ? 390 : 0, landscape ? -155 : -242, landscape ? 400 : 520, 96),
        start: target(landscape ? -290 : 0, landscape ? -263 : -356, 520, 96),
        practice: target(landscape ? 290 : 0, landscape ? -263 : -466, 520, 96),
    });
    const cardX = landscape ? [-306, 306] : [0, 0], cardY = landscape ? [45, 45] : [240, -100];
    const intro = Object.freeze({
        title: box(0, landscape ? 300 : 520, 680, 80),
        cards: frozenRects(cardX.map((x, i) => box(x, cardY[i], landscape ? 568 : 664, landscape ? 380 : 300))),
        portraits: frozenRects(cardX.map((x, i) => box(x - (landscape ? 170 : 222), cardY[i] - 12, landscape ? 180 : 176, landscape ? 180 : 176))),
        facets: frozenRects(cardX.map((x, i) => box(x, cardY[i] + (landscape ? 145 : 112), 540, 50))),
        names: frozenRects(cardX.map((x, i) => box(x + (landscape ? 88 : 84), cardY[i] + (landscape ? 65 : 45), landscape ? 326 : 430, 56))),
        stories: frozenRects(cardX.map((x, i) => box(x + (landscape ? 88 : 84), cardY[i] - (landscape ? 75 : 55), landscape ? 308 : 420, landscape ? 200 : 150))),
        enter: target(landscape ? 170 : 0, landscape ? -245 : -400, 520, 96),
        back: target(landscape ? -430 : 0, landscape ? -245 : -510, landscape ? 300 : 520, 96),
    });
    const top = height / 2 - 64, hpX = landscape ? 420 : 190;
    const controlsY = landscape ? -220 : -height / 2 + 136, controlsX = landscape ? 460 : 162;
    const battle = Object.freeze({
        roles: frozenRects([-hpX, hpX].map(x => box(x, top + 40, 300, 40))),
        hp: frozenRects([-hpX, hpX].map(x => box(x, top, 260, 64))),
        hpBars: frozenRects([-hpX, hpX].map(x => box(x, top - 48, 240, 16))),
        pause: target(0, top - 12, 112, 96), timer: box(0, top - 100, 300, 48),
        guard: target(-controlsX, controlsY, 300, 160), attack: target(controlsX, controlsY, 300, 160),
        status: box(0, landscape ? -300 : controlsY + 128, landscape ? 580 : 640, 48),
        feedback: box(0, landscape ? -110 : -240, landscape ? 580 : 640, 64),
        hint: box(0, landscape ? -190 : -312, landscape ? 580 : 640, 48),
        retry: target(landscape ? 470 : 0, top - (landscape ? 116 : 256), 260, 96),
    });
    const result = Object.freeze({
        title: box(0, landscape ? 304 : 540, 640, landscape ? 64 : 80),
        hp: box(0, landscape ? 240 : 476, 640, 64), mode: box(0, landscape ? 186 : 424, 640, 48),
        retry: target(landscape ? -290 : 0, landscape ? -240 : -400, landscape ? 420 : 520, 96),
        change: target(landscape ? 290 : 0, landscape ? -240 : -512, landscape ? 420 : 520, 96),
    });
    const common = Object.freeze({
        build: box(0, landscape ? -334 : -594, width - 48, 40),
        title: box(0, landscape ? 270 : 500, 640, 80),
        description: box(0, landscape ? 185 : 400, 640, landscape ? 76 : 96),
        role: box(0, landscape ? 125 : 310, 640, 48),
        primary: target(0, landscape ? 35 : 150, 520, 96),
        secondary: target(0, landscape ? -77 : 38, 520, 96),
        tertiary: target(0, landscape ? -189 : -74, 520, 96),
        back: target(landscape ? -480 : 0, landscape ? -260 : -202, landscape ? 240 : 520, 96),
    });
    return Object.freeze({ landscape, width, height, safe, cssScaleX: cssScale.x, cssScaleY: cssScale.y,
        minTargetWidth, minTargetHeight, box, target, menu, intro, battle, result, common });
}

function positive(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
}
function geometry(rect: LayoutRect, name: string): void {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) throw new Error(`Invalid ${name} origin`);
    positive(rect.width, `${name} width`); positive(rect.height, `${name} height`);
}
function frozenRect(x: number, y: number, width: number, height: number): LayoutRect {
    return Object.freeze({ x, y, width, height });
}
function frozenRects(rects: LayoutRect[]): readonly LayoutRect[] { return Object.freeze(rects); }
