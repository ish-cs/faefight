/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Temporal anti-aliasing upscaler: three r187's TAAUNode (MIT, examples/jsm/tsl/display/TAAUNode.js; Karis 2014 /
 * FSR 2 style, 9-tap Blackman-Harris reconstruction, variance-clipped history, thin-feature lock), forked for one
 * addition: a **reactive mask** in the velocity target's z channel (velocity.ts). Transparent FX (tracers, sparks,
 * muzzle flashes, rain, beams) write their coverage there; on those pixels the thin-feature lock is dropped and the
 * current frame gets most of the weight, so a fast bright streak never leaves a trail of locked history behind it.
 * Opaque surfaces write 0 and resolve exactly like upstream.
 */
import { DepthTexture, HalfFloatType, Matrix4, Node, NodeMaterial, NodeUpdateType, QuadMesh, RendererUtils, RenderTarget, Vector2 } from 'three/webgpu';
import {
  context, convertToTexture, exp, float, Fn, ivec2, luminance, max, mix, OnAfterRenderPipeline, OnBeforeRenderPipeline, outputStruct, passTexture,
  property, texture, uniform, uv, vec2, vec4, velocity,
} from 'three/tsl';
import { clipAABB, computeHaltonOffsets, flickerReduction, sampleCurrentDepth, samplePreviousDepth } from 'three/addons/tsl/utils/TAAUtils.js';

const quad = new QuadMesh(null as any);
const size = new Vector2();
let rendererState: any;
const HALTON = computeHaltonOffsets(32);

/** Current-frame weight on fully reactive pixels (1 = no history at all; 0.6 keeps a little anti-aliasing). */
const REACTIVE_WEIGHT = 0.6;

class TAAUNode extends Node {
  static get type() { return 'FaeTAAUNode'; }
  depthThreshold = 0.0005;
  edgeDepthDiff = 0.001;
  maxVelocityLength = 128;
  currentFrameWeight = 0.025;
  private jitterIndex = 0;
  private jitterOffset = uniform(new Vector2());
  private history = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType, count: 2 });
  private resolveRT = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
  private prevDepthRT = new RenderTarget(1, 1, { depthBuffer: false, depthTexture: new DepthTexture(1, 1) });
  private resolveMat = new NodeMaterial();
  private seedMat = new NodeMaterial();
  private textureNode: any;
  private originalProjection = new Matrix4();
  private nearFar = uniform(new Vector2());
  private camWorld = uniform(new Matrix4());
  private camWorldInv = uniform(new Matrix4());
  private projInv = uniform(new Matrix4());
  private prevCamWorld = uniform(new Matrix4());
  private prevProjInv = uniform(new Matrix4());
  private prevDepthNode: any;

  constructor(private beautyNode: any, private depthNode: any, private velocityNode: any, private camera: any) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.history.textures[0].name = 'TAAU.history.color';
    this.history.textures[1].name = 'TAAU.history.lock';
    this.resolveRT.texture.name = 'TAAU.resolve';
    this.prevDepthRT.depthTexture!.name = 'TAAU.previousDepth';
    this.resolveMat.name = 'TAAU.resolve';
    this.seedMat.name = 'TAAU.seed';
    this.textureNode = passTexture(this as any, this.resolveRT.texture);
    this.prevDepthNode = texture(this.prevDepthRT.depthTexture!);
  }

  getTextureNode() { return this.textureNode; }

  private setViewOffset(w: number, h: number) {
    this.camera.updateProjectionMatrix();
    this.originalProjection.copy(this.camera.projectionMatrix);
    (velocity as any).setProjectionMatrix(this.originalProjection);
    const [hx, hy] = HALTON[this.jitterIndex];
    this.jitterOffset.value.set(hx - 0.5, hy - 0.5);
    this.camera.setViewOffset(w, h, hx - 0.5, hy - 0.5, w, h);
  }

  private clearViewOffset() {
    this.camera.clearViewOffset();
    (velocity as any).setProjectionMatrix(null);
    this.jitterIndex = (this.jitterIndex + 1) % HALTON.length;
  }

  updateBefore(frame: any): undefined {
    const { renderer } = frame;
    this.prevCamWorld.value.copy(this.camWorld.value);
    this.prevProjInv.value.copy(this.projInv.value);
    this.nearFar.value.set(this.camera.near, this.camera.far);
    this.camWorld.value.copy(this.camera.matrixWorld);
    this.camWorldInv.value.copy(this.camera.matrixWorldInverse);
    this.projInv.value.copy(this.camera.projectionMatrixInverse);
    const { width, height } = renderer.getDrawingBufferSize(size);
    rendererState = RendererUtils.resetRendererState(renderer, rendererState);
    const restart = this.history.width !== width || this.history.height !== height;
    this.history.setSize(width, height);
    this.resolveRT.setSize(width, height);
    if (restart) {
      // seed with a bilinear upscale of the current frame so a resize never fades in from black
      renderer.setRenderTarget(this.history);
      quad.material = this.seedMat;
      quad.render(renderer);
      renderer.setRenderTarget(null);
    }
    renderer.setRenderTarget(this.resolveRT);
    quad.material = this.resolveMat;
    quad.render(renderer);
    renderer.setRenderTarget(null);
    renderer.copyTextureToTexture(this.resolveRT.texture, this.history.texture);
    const depth = this.depthNode.value;
    const sw = depth.image?.width ?? 0, sh = depth.image?.height ?? 0;
    if (sw > 0 && sh > 0) {
      if (this.prevDepthRT.width !== sw || this.prevDepthRT.height !== sh) this.prevDepthRT.setSize(sw, sh);
      renderer.copyTextureToTexture(depth, this.prevDepthRT.depthTexture);
    }
    RendererUtils.restoreRendererState(renderer, rendererState);
    return undefined;
  }

  setup(builder: any) {
    this.depthNode.build(builder);
    this.velocityNode.build(builder);
    this.beautyNode.build(builder);
    if (builder.renderPipeline && !builder.context.renderPipelineState.viewOffsetOwner) {
      builder.context.renderPipelineState.viewOffsetOwner = this;
      OnBeforeRenderPipeline(() => {
        const rt = this.beautyNode.isRTTNode ? this.beautyNode.renderTarget : this.beautyNode.passNode.renderTarget;
        this.setViewOffset(rt.texture.width, rt.texture.height);
      });
      OnAfterRenderPipeline(() => this.clearViewOffset());
    }
    this.prevDepthRT.depthTexture!.format = this.depthNode.value.format;
    this.prevDepthRT.depthTexture!.type = this.depthNode.value.type;
    const historyNode = texture(this.history.textures[0]);
    const lockNode = texture(this.history.textures[1]);
    const colorOut = property('vec4'), lockOut = property('vec4');
    const outputNode = outputStruct(colorOut, lockOut);

    const resolve = Fn(() => {
      const uvNode = uv();
      const inSize = vec2(this.beautyNode.size());
      const pIn = uvNode.mul(inSize);
      const closestTapF = pIn.sub(vec2(0.5).add(this.jitterOffset)).round();
      const closestTap = ivec2(closestTapF);
      const cur = sampleCurrentDepth(this.depthNode, closestTapF, this.nearFar);
      const closestDepth = cur.get('closestDepth'), closestTexel = cur.get('closestPositionTexel'), farthestDepth = cur.get('farthestDepth');
      const vel = this.velocityNode.load(closestTexel);
      // reactive: transparent FX coverage at the pixel itself or its dilated depth tap (velocity.ts)
      const reactive = max(vel.z, this.velocityNode.load(closestTap).z).saturate().toConst();
      const historyUV = uvNode.sub(vel.xy.mul(vec2(0.5, -0.5)));
      const prevDepth = samplePreviousDepth(this.prevDepthNode, historyUV, this.prevProjInv, this.prevCamWorld, this.camWorldInv, this.nearFar, this.camera);
      const validUV = historyUV.greaterThanEqual(0).all().and(historyUV.lessThanEqual(1).all());
      const isEdge = farthestDepth.sub(closestDepth).greaterThan(this.edgeDepthDiff);
      const disoccluded = closestDepth.sub(prevDepth).greaterThan(this.depthThreshold);
      const validHistory = validUV.and(isEdge.or(disoccluded.not()));

      const sumColor = vec4(0).toVar(), sumW = float(0).toVar(), m1 = vec4(0).toVar(), m2 = vec4(0).toVar();
      for (const [x, y] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
        const tap = closestTap.add(ivec2(x, y));
        const d = pIn.sub(vec2(tap).add(vec2(0.5).add(this.jitterOffset)));
        const w = exp(d.dot(d).mul(-2.29));
        const c = this.beautyNode.load(tap).max(0);
        sumColor.addAssign(c.mul(w)); sumW.addAssign(w); m1.addAssign(c); m2.addAssign(c.pow2());
      }
      const current = sumColor.div(sumW.max(1e-5));
      const mean = m1.div(9);
      const motion = uvNode.sub(historyUV).mul(inSize).length().div(this.maxVelocityLength).saturate();
      const gamma = mix(0.5, 1, motion.oneMinus().pow2());
      const sd = m2.div(9).sub(mean.pow2()).max(0).sqrt().mul(gamma);
      const lo = mean.sub(sd), hi = mean.add(sd);
      const hist = historyNode.sample(historyUV);
      const clipped = clipAABB(mean.clamp(lo, hi), hist, lo, hi);
      const meanLuma = luminance(mean.rgb).toConst();
      const thin = luminance(current.rgb).sub(meanLuma).abs().div(meanLuma).smoothstep(0, 0.2);
      const depthChanged = closestDepth.sub(prevDepth).abs().greaterThan(this.depthThreshold);
      const thinLock = validUV.and(depthChanged.not()).select(thin, float(0));
      const lock = max(thinLock, lockNode.r.mul(disoccluded.select(0, 0.5))).saturate().mul(reactive.oneMinus());
      const locked = mix(clipped, hist, lock);
      const wCur = float(this.currentFrameWeight).toVar();
      wCur.assign(validHistory.select(wCur.add(motion).saturate(), 1));
      wCur.assign(max(wCur, reactive.mul(REACTIVE_WEIGHT)));
      colorOut.assign(flickerReduction(current, locked, wCur));
      lockOut.assign(lock);
      return vec4(0);
    });
    const shared = context(builder.getSharedContext());
    this.resolveMat.contextNode = shared;
    this.resolveMat.colorNode = resolve();
    this.resolveMat.outputNode = outputNode;
    this.seedMat.colorNode = Fn(() => { colorOut.assign(this.beautyNode.sample(uv())); lockOut.assign(0); return vec4(0); })();
    this.seedMat.contextNode = shared;
    this.seedMat.outputNode = outputNode;
    return this.textureNode;
  }

  dispose() {
    super.dispose();
    this.history.dispose(); this.resolveRT.dispose(); this.prevDepthRT.dispose(); this.resolveMat.dispose(); this.seedMat.dispose();
  }
}

/** TAAU of `beauty` (scene pass at input resolution) to the drawing-buffer size; MSAA must be off. */
export const taau = (beauty: any, depth: any, vel: any, camera: any): TAAUNode => new TAAUNode(convertToTexture(beauty), depth, vel, camera);
