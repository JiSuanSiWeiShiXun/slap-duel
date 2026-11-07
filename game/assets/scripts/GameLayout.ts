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
    throw new Error('Layout conversion is not implemented');
}

/** sys.getSafeAreaRect(false) is already UI space; do not divide it by scale again. */
export function layoutFromUiSafeRect(design: DesignSize, safeRect: LayoutRect, cssScale: AxisScale): GameLayout {
    throw new Error('Layout is not implemented');
}
