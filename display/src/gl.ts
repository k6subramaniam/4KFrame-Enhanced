/**
 * Minimal WebGL transition renderer in the gl-transitions style.
 *
 * Renders a transition between two source canvases (the "from" and "to" composed
 * frames) over a duration. The fragment shader wraps a gl-transitions snippet and
 * provides `getFromColor` / `getToColor` / `progress` / `ratio`.
 *
 * It also blits video frames (`drawVideo`), through a second, independent program so
 * the transition path is untouched. Some TV browsers never composite an in-page
 * `<video>` element onto the panel, but they do composite this canvas — it is how every
 * photo reaches the screen — so routing video frames through here is what makes them
 * visible there.
 */

import { glslFor } from './transitions.js';

const VERT = `
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = vec2(0.5, 0.5) * (position + 1.0);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

/**
 * Video blit. `uvScale`/`uvOffset` carry the clip's own rotation/flip as a UV mapping, so
 * the destination rect stays an axis-aligned viewport and nothing else has to know about
 * orientation.
 */
const VIDEO_VERT = `
attribute vec2 position;
uniform mat2 uvScale;
varying vec2 vUv;
void main() {
  vec2 uv = vec2(0.5, 0.5) * (position + 1.0);
  vUv = uvScale * (uv - 0.5) + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const VIDEO_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D src;
void main() { gl_FragColor = texture2D(src, vec2(vUv.x, 1.0 - vUv.y)); }`;

/** A rectangle in the canvas's own CSS pixel space (origin top-left). */
export interface GLRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GLVideoOrientation {
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

/**
 * The clip's own rotation/flip as an inverse mapping from screen position to source UV.
 *
 * Screen rotation is clockwise (CSS `rotate`), so the sampling rotation is the
 * counter-clockwise one; the flips are applied in source space, matching the order CSS
 * applies `rotate(...) scale(...)`. Returned column-major, as mat2 uniforms expect.
 */
function uvMatrix({ rotation, flipHorizontal, flipVertical }: GLVideoOrientation): Float32Array {
  const rad = ((rotation % 360) * Math.PI) / 180;
  const co = Math.round(Math.cos(rad) * 1e6) / 1e6;
  const si = Math.round(Math.sin(rad) * 1e6) / 1e6;
  const fx = flipHorizontal ? -1 : 1;
  const fy = flipVertical ? -1 : 1;
  return new Float32Array([fx * co, fy * si, -fx * si, fy * co]);
}

function intersect(a: GLRect, b: GLRect): GLRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function fragmentFor(transitionGlsl: string): string {
  return `
precision highp float;
varying vec2 vUv;
uniform sampler2D from, to;
uniform float progress, ratio;
vec4 getFromColor(vec2 uv) { return texture2D(from, vec2(uv.x, 1.0 - uv.y)); }
vec4 getToColor(vec2 uv) { return texture2D(to, vec2(uv.x, 1.0 - uv.y)); }
${transitionGlsl}
void main() { gl_FragColor = transition(vUv); }`;
}

export class GLRenderer {
  private gl: WebGLRenderingContext;
  private texFrom: WebGLTexture;
  private texTo: WebGLTexture;
  private texVideo: WebGLTexture;
  private program: WebGLProgram | null = null;
  private videoProgram: WebGLProgram | null = null;
  private currentTransition = '';
  /** Device-pixel region covered by the last drawVideo(), for sampleIsBlank(). */
  private lastVideoRegion: GLRect | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;
    this.texFrom = this.createTexture();
    this.texTo = this.createTexture();
    this.texVideo = this.createTexture();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  private compile(transition: string): void {
    if (this.currentTransition === transition && this.program) return;
    const gl = this.gl;
    const vs = this.shader(gl.VERTEX_SHADER, VERT);
    const fs = this.shader(gl.FRAGMENT_SHADER, fragmentFor(glslFor(transition)));
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(program));
    }
    this.program = program;
    this.currentTransition = transition;
  }

  /**
   * Point the `position` attribute at the shared quad for `program`.
   *
   * Two programs now share one buffer and their attribute slots need not agree, so this
   * runs per draw setup rather than once at compile time.
   */
  private bindQuad(program: WebGLProgram): void {
    const gl = this.gl;
    const loc = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private shader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  private upload(tex: WebGLTexture, src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Draw a single static frame (no transition). */
  show(frame: TexImageSource): void {
    this.transition(frame, frame, 'fade.glsl', 0).catch(() => undefined);
  }

  /**
   * Blit one video frame.
   *
   * `dest` is where the picture goes and `clip` is the frame's content rect — both in this
   * canvas's CSS pixels, origin top-left. `dest` may extend past `clip` (that is how
   * `cover` overflow and pan behave), so the draw is scissored to `clip`. Everything else
   * is cleared transparent rather than black, leaving #video-bg's blurred poster (blur
   * mode) and the page's own black backdrop to show through exactly as before.
   *
   * Throws if the source cannot be sampled (a protected decode path); callers treat that
   * as "this engine can't do it" and fall back to the <video> element.
   */
  drawVideo(src: TexImageSource, dest: GLRect, clip: GLRect, orient: GLVideoOrientation): void {
    const gl = this.gl;
    this.compileVideo();
    this.resize();
    this.upload(this.texVideo, src);

    const program = this.videoProgram!;
    gl.useProgram(program);
    this.bindQuad(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.uniform1i(gl.getUniformLocation(program, 'src'), 0);
    gl.uniformMatrix2fv(gl.getUniformLocation(program, 'uvScale'), false, uvMatrix(orient));

    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const scissor = this.toDevice(clip);
    const viewport = this.toDevice(dest);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(scissor.x, scissor.y, scissor.w, scissor.h);
    gl.viewport(viewport.x, viewport.y, viewport.w, viewport.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
    // resize() sets the viewport, but transitions read it before resizing, so restore it.
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.lastVideoRegion = intersect(scissor, viewport);
  }

  /**
   * Whether the last drawVideo() put nothing but black on the canvas.
   *
   * Some TV decoders hand video frames to the compositor on a protected path that
   * texImage2D cannot read; it succeeds and yields black rather than failing. Must be
   * called in the same task as the draw — the drawing buffer is not preserved across
   * presentation.
   */
  lastVideoDrawIsBlank(): boolean {
    const region = this.lastVideoRegion;
    if (!region || region.w < 3 || region.h < 3) return false;
    const gl = this.gl;
    const px = new Uint8Array(4);
    for (let iy = 1; iy <= 3; iy += 1) {
      for (let ix = 1; ix <= 3; ix += 1) {
        const x = region.x + Math.floor((region.w * ix) / 4);
        const y = region.y + Math.floor((region.h * iy) / 4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (px[0] || px[1] || px[2]) return false;
      }
    }
    return true;
  }

  private compileVideo(): void {
    if (this.videoProgram) return;
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, this.shader(gl.VERTEX_SHADER, VIDEO_VERT));
    gl.attachShader(program, this.shader(gl.FRAGMENT_SHADER, VIDEO_FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Video program link failed: ' + gl.getProgramInfoLog(program));
    }
    this.videoProgram = program;
  }

  /** CSS px, origin top-left -> device px, origin bottom-left (GL's convention). */
  private toDevice(r: GLRect): GLRect {
    const sx = this.canvas.clientWidth ? this.canvas.width / this.canvas.clientWidth : 1;
    const sy = this.canvas.clientHeight ? this.canvas.height / this.canvas.clientHeight : 1;
    return {
      x: Math.round(r.x * sx),
      y: Math.round(this.canvas.height - (r.y + r.h) * sy),
      w: Math.max(1, Math.round(r.w * sx)),
      h: Math.max(1, Math.round(r.h * sy)),
    };
  }

  /** Animate a transition from `from` to `to`. Resolves when complete. */
  transition(from: TexImageSource, to: TexImageSource, name: string, durationSec: number): Promise<void> {
    this.compile(name);
    this.resize();
    const gl = this.gl;
    this.upload(this.texFrom, from);
    this.upload(this.texTo, to);
    const program = this.program!;
    gl.useProgram(program);
    this.bindQuad(program);
    gl.uniform1i(gl.getUniformLocation(program, 'from'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'to'), 1);
    gl.uniform1f(gl.getUniformLocation(program, 'ratio'), this.canvas.width / this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texFrom);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texTo);

    const progressLoc = gl.getUniformLocation(program, 'progress');
    const start = performance.now();
    const durationMs = Math.max(0, durationSec * 1000);

    return new Promise((resolve) => {
      const frame = (now: number) => {
        const p = durationMs === 0 ? 1 : Math.min(1, (now - start) / durationMs);
        gl.uniform1f(progressLoc, p);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }
}
