/*
 * preview.js — three.js viewport showing the assembled banner, optionally hanging
 * over a ghost of a DM screen so the hanger geometry is legible at a glance.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Preview {
    constructor(canvas) {
        this.canvas = canvas;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 2000);
        this.camera.position.set(0, 0, 190);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.09;
        this.controls.rotateSpeed = 0.8;

        this.scene.add(new THREE.HemisphereLight(0xe6dfc9, 0x35352c, 2.2));
        const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
        key.position.set(-70, 110, 150);
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0xaebfdd, 1.1);
        fill.position.set(110, -40, 90);
        this.scene.add(fill);
        const rim = new THREE.DirectionalLight(0xffffff, 0.7);
        rim.position.set(-20, 60, -150);
        this.scene.add(rim);

        this.group = new THREE.Group();
        this.scene.add(this.group);

        this.screen = this.buildScreen();
        this.scene.add(this.screen);

        this.needsFrame = true;
        this.resizeObserver = new ResizeObserver(() => { this.resize(); });
        this.resizeObserver.observe(canvas.parentElement || canvas);
        this.resize();
        this.controls.addEventListener('change', () => { this.needsFrame = true; });
        this.loop();
    }

    buildScreen() {
        const g = new THREE.Group();
        // Deliberately desaturated and see-through: this is a stand-in for the DM screen
        // so the hanger reads in context, and it must never compete with the banner.
        const mat = new THREE.MeshStandardMaterial({
            color: 0x4a5058, roughness: 0.95, metalness: 0,
            transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide,
        });
        const panel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        g.add(panel);
        this.screenPanel = panel;
        return g;
    }

    setScreenVisible(on) {
        this.screen.visible = on;
        this.needsFrame = true;
    }

    /** parts: [{ key, color, positions }] in model space (y down from the top edge). */
    setParts(parts, metrics, cfg) {
        for (const child of [...this.group.children]) {
            child.geometry.dispose();
            child.material.dispose();
            this.group.remove(child);
        }
        for (const part of parts) {
            if (!part.positions.length) continue;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(part.positions), 3));
            geom.computeVertexNormals();
            const mat = new THREE.MeshStandardMaterial({
                color: new THREE.Color(part.color || '#cccccc'),
                roughness: 0.68, metalness: 0.02, flatShading: true,
            });
            this.group.add(new THREE.Mesh(geom, mat));
        }

        // Ghost screen: its top edge tucks under the hanger bar so the fit is obvious.
        if (cfg && cfg.hanger.mode !== 'none') {
            const st = cfg.hanger.screenThickness;
            const t = cfg.size.plateThickness;
            const ft = cfg.hanger.mode === 'separate' ? cfg.hanger.flangeThickness : 0;
            const w = metrics.barWidth * 1.5;
            const h = metrics.height * 0.85;
            const top = -cfg.hanger.thickness;
            this.screenPanel.geometry.dispose();
            this.screenPanel.geometry = new THREE.BoxGeometry(w, h, st);
            this.screenPanel.position.set(0, top - h / 2, -(t + ft) - st / 2);
            this.screen.visible = this.wantScreen !== false;
        } else {
            this.screen.visible = false;
        }

        this.frame(metrics);
        this.needsFrame = true;
    }

    frame(metrics) {
        if (this.framed) return;
        const h = metrics ? metrics.height : 62;
        const w = metrics ? metrics.barWidth : 52;
        // Fit the taller of the two axes, then back off a little and swing slightly to
        // one side so the hanger bar and the plate thickness are both readable.
        const fovY = (this.camera.fov * Math.PI) / 180;
        const distV = (h / 2) / Math.tan(fovY / 2);
        const distH = (w / 2) / Math.tan(fovY / 2) / Math.max(this.camera.aspect, 0.4);
        const dist = Math.max(distV, distH) * 1.25;
        const yaw = 0.34, pitch = 0.20;
        this.controls.target.set(0, -h / 2, 0);
        this.camera.position.set(
            Math.sin(yaw) * dist,
            -h / 2 + Math.sin(pitch) * dist,
            Math.cos(yaw) * Math.cos(pitch) * dist,
        );
        this.controls.update();
        this.framed = true;
    }

    resetView(metrics) {
        this.framed = false;
        this.frame(metrics);
        this.needsFrame = true;
    }

    resize() {
        const el = this.canvas.parentElement || this.canvas;
        const w = Math.max(1, el.clientWidth);
        const h = Math.max(1, el.clientHeight);
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.needsFrame = true;
    }

    loop() {
        requestAnimationFrame(() => this.loop());
        const damping = this.controls.update();
        if (this.needsFrame || damping) {
            this.renderer.render(this.scene, this.camera);
            this.needsFrame = false;
        }
    }
}
