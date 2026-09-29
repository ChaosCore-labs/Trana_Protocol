import type { GruvboxPalette } from './palette'

/**
 * Mermaid theme variables derived from the gruvbox material palette.
 *
 * Mermaid is initialised with `theme: 'base'`, which makes every colour come
 * from these variables — without them the diagrams keep mermaid's own palette
 * and sit on the gruvbox page as an obvious mismatch.
 *
 * Variable names are mermaid's; the grouping follows its theme contract.
 */
export function mermaidThemeVariables(
  p: GruvboxPalette,
  fontFamily: string,
): Record<string, string | boolean> {
  return {
    darkMode: true,
    fontFamily,

    // Surfaces and text. Borders use grey1 rather than grey0: grey0 is the
    // dimmest ramp entry and leaves node outlines barely visible on the page.
    background: p.bg0,
    primaryColor: p.bg1,
    primaryTextColor: p.fg0,
    primaryBorderColor: p.grey1,
    secondaryColor: p.bg3,
    tertiaryColor: p.bgDim,
    titleColor: p.fg0,
    nodeTextColor: p.fg0,
    textColor: p.fg0,

    // Edges and clusters
    lineColor: p.grey1,
    clusterBkg: p.bgDim,
    clusterBorder: p.grey1,
    edgeLabelBackground: p.bg0,

    // Sequence diagrams
    actorBkg: p.bg3,
    actorBorder: p.grey1,
    actorTextColor: p.fg0,
    actorLineColor: p.grey1,
    signalColor: p.grey2,
    signalTextColor: p.fg0,
    labelBoxBkgColor: p.bg1,
    labelBoxBorderColor: p.grey1,
    labelTextColor: p.fg0,
    loopTextColor: p.fg0,
    noteBkgColor: p.bgVisualYellow,
    noteBorderColor: p.yellow,
    noteTextColor: p.fg0,
    activationBkgColor: p.bg3,
    activationBorderColor: p.grey1,
    sequenceNumberColor: p.bg0,

    // State diagrams
    labelBackgroundColor: p.bg0,
    altBackground: p.bgDim,

    // Gantt / timeline
    sectionBkgColor: p.bgDim,
    altSectionBkgColor: p.bg0,
    sectionBkgColor2: p.bgDim,
    taskBkgColor: p.blue,
    taskBorderColor: p.grey1,
    taskTextColor: p.bg0,
    taskTextDarkColor: p.bg0,
    taskTextLightColor: p.fg0,
    taskTextOutsideColor: p.fg0,
    activeTaskBkgColor: p.yellow,
    activeTaskBorderColor: p.yellow,
    doneTaskBkgColor: p.grey0,
    doneTaskBorderColor: p.grey1,
    critBkgColor: p.red,
    critBorderColor: p.red,
    todayLineColor: p.red,
    gridColor: p.bg3,

    // Quadrant / misc accents
    quadrant1Fill: p.bgVisualGreen,
    quadrant2Fill: p.bgVisualBlue,
    quadrant3Fill: p.bgVisualYellow,
    quadrant4Fill: p.bgVisualRed,
    quadrant1TextFill: p.fg0,
    quadrant2TextFill: p.fg0,
    quadrant3TextFill: p.fg0,
    quadrant4TextFill: p.fg0,
    quadrantPointFill: p.grey1,
    quadrantPointTextFill: p.fg0,
    quadrantTitleFill: p.fg0,
  }
}
