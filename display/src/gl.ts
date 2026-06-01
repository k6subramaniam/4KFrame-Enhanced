/**
 * Minimal WebGL transition renderer in the gl-transitions style.
 *
 * Renders a transition between two source canvases (the "from" and "to" composed
 * frames) over a duration. The fragment shader wraps a gl-transitions snippet and
 * provides `getFromColor` / `getToColor` / `progress` / `ratio`.
 */

import { glslFor } from './transitions.js';

const VERT = `
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = vec2(0.5, 0.5) * (position + 1.0);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

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
  private program: WebGLProgram | null = null;
  private currentTransition = '';

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;
    this.texFrom = this.createTexture();
    this.texTo = this.createTexture();
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

  /** Animate a transition from `from` to `to`. Resolves when complete. */
  transition(from: TexImageSource, to: TexImageSource, name: string, durationSec: number): Promise<void> {
    this.compile(name);
    this.resize();
    const gl = this.gl;
    this.upload(this.texFrom, from);
    this.upload(this.texTo, to);
    const program = this.program!;
    gl.useProgram(program);
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
