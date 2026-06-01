/**
 * GLSL transitions in the gl-transitions format. Each snippet defines:
 *   vec4 transition(vec2 uv)
 * with the implicit uniforms `from`, `to`, `progress`, `ratio` provided by the
 * renderer. These are the transitions referenced by the original frame
 * (flyeye, cube, wipeDown, …) plus a default fade.
 *
 * Authors of the originals (CC-BY / MIT on gl-transitions.com): gre, fkuteken et al.
 */

export const TRANSITION_GLSL: Record<string, string> = {
  'fade.glsl': `
    vec4 transition(vec2 uv) {
      return mix(getFromColor(uv), getToColor(uv), progress);
    }`,

  'wipeDown.glsl': `
    vec4 transition(vec2 uv) {
      vec2 p = uv + vec2(0.0, 1.0) * progress;
      return mix(getToColor(uv), getFromColor(p), step(p.y, 1.0));
    }`,

  'wipeUp.glsl': `
    vec4 transition(vec2 uv) {
      vec2 p = uv + vec2(0.0, -1.0) * progress;
      return mix(getToColor(uv), getFromColor(p), step(0.0, p.y));
    }`,

  // Simplified cube-style horizontal push (approximation of the gl-transitions cube).
  'cube.glsl': `
    vec4 transition(vec2 uv) {
      float x = uv.x - progress;
      if (x >= 0.0) return getFromColor(vec2(x, uv.y));
      return getToColor(vec2(x + 1.0, uv.y));
    }`,

  'cube-left.glsl': `
    vec4 transition(vec2 uv) {
      float x = uv.x + progress;
      if (x <= 1.0) return getFromColor(vec2(x, uv.y));
      return getToColor(vec2(x - 1.0, uv.y));
    }`,

  // Flyeye: ripple-style dissolve (approximation).
  'flyeye.glsl': `
    vec4 transition(vec2 uv) {
      float size = 0.04;
      float zoom = 50.0;
      float colorSep = 0.3;
      float inv = 1.0 - progress;
      vec2 disp = size * vec2(cos(zoom * uv.x), sin(zoom * uv.y));
      vec4 texTo = getToColor(uv + inv * disp);
      vec4 texFrom = getFromColor(uv + progress * disp * (1.0 - colorSep));
      return mix(texFrom, texTo, progress);
    }`,
};

export function glslFor(name: string): string {
  return TRANSITION_GLSL[name] ?? TRANSITION_GLSL['fade.glsl'];
}
