import { graph, Dijkstras } from "./graph.js";

// Pan/zoom session state ──────────────────────────────────────────────────────
// canvas:      per-gesture snapshot (mouse/touch start position, transform, SCTM)
// scale:       current zoom level kept in sync with the SVG matrix
// canvasWidth/Height: intrinsic dimensions of the SVG canvas (fixed at 1900×1900)
// velocity:    current pan speed (element-space px / ms), tracked during a drag
//              and used to drive the momentum/inertia animation after release
// momentumFrame: requestAnimationFrame id for the running momentum loop, so it
//              can be cancelled if a new gesture starts or a zoom happens
// frameAnimFrame: requestAnimationFrame id for the "frame the path" animation
//              triggered after a path is found, cancellable the same way
let canvas = {};
let canvasHeight;
let canvasWidth;
let scale = 1;
let myGraph;
let velocity = { x: 0, y: 0 };
let momentumFrame = null;
let frameAnimFrame = null;

// Tuning knobs for the momentum/inertia effect.
const FRICTION_PER_MS = 0.003; // higher = decays/stops sooner
const MIN_VELOCITY = 0.005; // px/ms below which momentum just stops
const VELOCITY_SMOOTHING = 0.3; // weight given to the newest sample in the EMA

// Tuning knobs for the "frame the path" auto-zoom.
const FRAME_PADDING = 150; // extra margin (in canvas units) around the path bbox
const FRAME_DURATION = 500; // ms for the fit animation

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadNodes(filePath, graph, canvas) {
	// Fetches node definitions from a JSON file, registers each node in the
	// in-memory graph, and renders it as an SVG circle inside the canvas element.
	const data = await fetch(filePath).then((response) => response.json());
	const nodes = data.nodes;
	const nodeGroup = canvas.querySelector("#nodes");

	for (const [nodeName, nodeData] of Object.entries(nodes)) {
		const position = nodeData.position;
		const newNode = graph.createNode(position.x, position.y, nodeName);
		placeNode(nodeGroup, newNode, 2);
	}

	loadEdges(filePath, graph);
	return graph;
}

async function loadEdges(filePath, graph) {
	// Fetches edge definitions and adds them to the graph.
	// Virtual edges (entrance connectors) are directed with weight 0;
	// real edges are weighted by the Euclidean distance between their nodes.
	const data = await fetch(filePath).then((response) => response.json());
	const edges = data.edges;

	for (const edge of edges) {
		let edgeWeight;
		let isDirected = false;
		if (edge.isVirtual) {
			isDirected = true;
			edgeWeight = 0;
		} else {
			edgeWeight = distance(graph.getNode(edge.from), graph.getNode(edge.to));
		}
		graph.createEdge(edgeWeight, edge.from, edge.to, isDirected);
	}
	return graph;
}

function placeNode(container, nodeData, radius) {
	// Creates an SVG <circle> for a graph node and appends it to the given group.
	const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	node.setAttribute("id", nodeData.getName());
	node.setAttribute("cx", nodeData.xCoord);
	node.setAttribute("cy", nodeData.yCoord);
	node.setAttribute("r", radius);
	node.setAttribute("fill", "#ff6161");
	node.setAttribute("visibility", "hidden");
	container.appendChild(node);
}

// ── Initialisation ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
	fetch("vector_map_final.svg")
		.then((response) => response.text())
		.then(async (svgContent) => {
			const parser = new DOMParser();
			const fileContent = parser.parseFromString(svgContent, "image/svg+xml");
			myGraph = new graph();

			const svg = fileContent.querySelector("svg");
			loadNodes("./data/db.json", myGraph, svg);

			// Canvas dimensions are fixed to match the SVG viewBox.
			canvasHeight = 1900;
			canvasWidth = 1900;

			// The <g id="lines"> group is appended last inside #main so route lines
			// render above all node circles (later siblings paint on top in SVG).
			const linesGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
			linesGroup.id = "lines";
			svg.querySelector("#main").appendChild(linesGroup);

			document.getElementById("svg-container").appendChild(svg);

			// Seed an explicit identity matrix so getTransform() always finds a
			// baseVal to consolidate rather than returning null.
			svg.querySelector("#main").setAttribute("transform", "matrix(1, 0, 0, 1, 0, 0)");

			svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
			svg.style.width = "100vw";
			svg.style.height = "100vh";
			svg.style.display = "block";

			const container = document.getElementById("svg-container");
			container.addEventListener("wheel", onZoom);
			container.addEventListener("mousedown", panStart);
			container.addEventListener("touchstart", touchStart, { passive: false });
		});
});

// ── Coordinate space conversion ───────────────────────────────────────────────

function viewPortToElementCoordinateSpaceTransformation(x, y, sctm = null) {
	// Converts a point from viewport (screen) pixel coordinates into the SVG
	// element's internal coordinate space.
	//
	// The SVG element has its own coordinate system that shifts as we pan and zoom.
	// getScreenCTM() returns the composite 2D matrix that maps element coords →
	// screen pixels. Inverting that matrix and applying it to the input point gives
	// the equivalent position in element space.
	//
	// sctm is passed explicitly wherever possible so we avoid querying the DOM on
	// every mouse/touch move event.
	const p = new DOMPoint(x, y);
	const screenCTM = sctm ?? document.getElementById("main").getScreenCTM();
	const transformedPoint = p.matrixTransform(screenCTM.inverse());
	return { x: transformedPoint.x, y: transformedPoint.y };
}

// ── Momentum / inertia ────────────────────────────────────────────────────────

function stopMomentum() {
	// Cancels any in-flight momentum animation and clears the velocity so a new
	// gesture starts from a clean state.
	if (momentumFrame) {
		cancelAnimationFrame(momentumFrame);
		momentumFrame = null;
	}
	velocity = { x: 0, y: 0 };
}

function trackVelocity(dt, deltaX, deltaY) {
	// Updates the smoothed velocity estimate (element-space px / ms) from the
	// latest pointer delta. An exponential moving average is used rather than the
	// raw instantaneous speed so a single noisy/fast event right before release
	// doesn't produce a wild flick.
	const safeDt = Math.max(dt, 1); // guard against div-by-zero on duplicate events
	velocity.x = velocity.x * (1 - VELOCITY_SMOOTHING) + (deltaX / safeDt) * VELOCITY_SMOOTHING;
	velocity.y = velocity.y * (1 - VELOCITY_SMOOTHING) + (deltaY / safeDt) * VELOCITY_SMOOTHING;
}

function startMomentum() {
	// Launches a decaying animation that continues panning in the direction the
	// gesture was moving when released, slowing to a stop. No-ops if the release
	// velocity is too small to bother animating.
	const speed = Math.hypot(velocity.x, velocity.y);
	if (speed < MIN_VELOCITY) {
		velocity = { x: 0, y: 0 };
		return;
	}

	let lastTime = performance.now();

	function step(now) {
		const dt = now - lastTime;
		lastTime = now;

		// Frame-rate independent exponential decay, so the glide feels the same
		// regardless of display refresh rate.
		const decay = Math.exp(-FRICTION_PER_MS * dt);
		velocity.x *= decay;
		velocity.y *= decay;

		const [a, b, c, d, panX, panY] = getTransform();
		const targetX = panX + velocity.x * dt;
		const targetY = panY + velocity.y * dt;
		const { x, y } = constrainPan(targetX, targetY, scale);

		// If we hit a pan boundary, kill velocity on that axis so we don't keep
		// pushing against the wall for the remaining decay.
		if (x !== targetX) velocity.x = 0;
		if (y !== targetY) velocity.y = 0;

		document.getElementById("main").setAttribute("transform", `matrix(${a}, ${b}, ${c}, ${d}, ${x}, ${y})`);

		if (Math.hypot(velocity.x, velocity.y) > MIN_VELOCITY) {
			momentumFrame = requestAnimationFrame(step);
		} else {
			momentumFrame = null;
			velocity = { x: 0, y: 0 };
		}
	}

	momentumFrame = requestAnimationFrame(step);
}

// ── Frame-to-path auto zoom ───────────────────────────────────────────────────

function cancelFrameAnimation() {
	// Cancels any in-flight "frame the path" animation. Called whenever the user
	// starts a new gesture, so a manual pan/zoom always takes priority.
	if (frameAnimFrame) {
		cancelAnimationFrame(frameAnimFrame);
		frameAnimFrame = null;
	}
}

function animateTransform(targetScale, targetPanX, targetPanY, duration) {
	// Smoothly interpolates the #main transform from its current state to the
	// target scale/pan over `duration` ms, using an ease-out cubic so the motion
	// settles rather than stopping abruptly.
	const [, b, c] = getTransform();
	const startScale = scale;
	const [, , , , startPanX, startPanY] = getTransform();
	const startTime = performance.now();

	function step(now) {
		const elapsed = now - startTime;
		const t = Math.min(elapsed / duration, 1);
		const eased = 1 - Math.pow(1 - t, 3);

		const currentScale = startScale + (targetScale - startScale) * eased;
		const currentPanX = startPanX + (targetPanX - startPanX) * eased;
		const currentPanY = startPanY + (targetPanY - startPanY) * eased;

		scale = currentScale;
		document.getElementById("main").setAttribute(
			"transform",
			`matrix(${currentScale}, ${b}, ${c}, ${currentScale}, ${currentPanX}, ${currentPanY})`,
		);

		if (t < 1) {
			frameAnimFrame = requestAnimationFrame(step);
		} else {
			frameAnimFrame = null;
		}
	}

	frameAnimFrame = requestAnimationFrame(step);
}

function frameToNodes(nodeNames, padding = FRAME_PADDING, duration = FRAME_DURATION) {
	// Computes the bounding box of the given nodes and animates the #main
	// transform so that box is centered and fully visible (with padding).
	//
	// This relies on the same coordinate convention constrainPan already uses:
	// canvasWidth/canvasHeight represent the viewport's extent in the same unit
	// space that node coordinates, scale, and the transform's pan (e, f) live in.
	// At scale=1/pan=0 the full 1900×1900 canvas exactly fills the viewport, so
	// "fit bbox to viewport" and "fit bbox to canvasWidth/canvasHeight" are the
	// same computation.
	if (!myGraph || !nodeNames || nodeNames.length === 0) return;

	const points = nodeNames
		.map((name) => myGraph.getNode(name))
		.filter((node) => node && Number.isFinite(node.xCoord) && Number.isFinite(node.yCoord))
		.map((node) => ({ x: node.xCoord, y: node.yCoord }));

	if (points.length === 0) return;

	stopMomentum();
	cancelFrameAnimation();

	const minX = Math.min(...points.map((p) => p.x));
	const maxX = Math.max(...points.map((p) => p.x));
	const minY = Math.min(...points.map((p) => p.y));
	const maxY = Math.max(...points.map((p) => p.y));

	const bboxWidth = Math.max(maxX - minX, 1);
	const bboxHeight = Math.max(maxY - minY, 1);
	const centerX = (minX + maxX) / 2;
	const centerY = (minY + maxY) / 2;

	// Largest scale at which the padded bounding box still fits the viewport.
	const scaleX = canvasWidth / (bboxWidth + padding * 2);
	const scaleY = canvasHeight / (bboxHeight + padding * 2);
	const targetScale = Math.max(1, Math.min(8, Math.min(scaleX, scaleY)));

	// Pan so the bbox center lands on the viewport center.
	const targetPanX = canvasWidth / 2 - targetScale * centerX;
	const targetPanY = canvasHeight / 2 - targetScale * centerY;
	const { x: constrainedX, y: constrainedY } = constrainPan(targetPanX, targetPanY, targetScale);

	animateTransform(targetScale, constrainedX, constrainedY, duration);
}

// ── Mouse pan ─────────────────────────────────────────────────────────────────

function panStart(e) {
	// Captures the pointer's starting position in element space and snapshots the
	// current SVG transform matrix. mousemove/mouseup are registered on `document`
	// rather than the SVG so a fast drag that leaves the element boundary doesn't
	// silently drop the listeners.
	stopMomentum();
	cancelFrameAnimation();

	const { clientX, clientY } = e;
	const sctm = document.getElementById("main").getScreenCTM();
	const transformed = viewPortToElementCoordinateSpaceTransformation(clientX, clientY, sctm);

	canvas = { mouseStart: transformed, transform: getTransform(), sctm, lastMoveTime: performance.now() };
	document.addEventListener("mousemove", onPan);
	document.addEventListener("mouseup", endPan);
}

function onPan(e) {
	// Translates the SVG map by the distance the pointer has moved since the last event.
	//
	// Why convert to element space then multiply by scale?
	// Both positions are transformed into element coordinates, so their difference
	// is in element units. The translation components (e and f) of the SVG matrix
	// live in screen/viewport pixels, so we multiply the delta by the current scale
	// to convert element-space units back to viewport pixels before adding it to
	// the existing translation.
	const { clientX, clientY } = e;
	const now = performance.now();
	const currentMousePosition = viewPortToElementCoordinateSpaceTransformation(clientX, clientY, canvas.sctm);
	const [a, b, c, d, translateX, translateY] = canvas.transform;

	const mouseDelta = {
		x: (currentMousePosition.x - canvas.mouseStart.x) * scale,
		y: (currentMousePosition.y - canvas.mouseStart.y) * scale,
	};

	trackVelocity(now - (canvas.lastMoveTime ?? now), mouseDelta.x, mouseDelta.y);
	canvas.lastMoveTime = now;

	const { x, y } = constrainPan(translateX + mouseDelta.x, translateY + mouseDelta.y, scale);
	document.getElementById("main").setAttribute("transform", `matrix(${a}, ${b}, ${c}, ${d}, ${x}, ${y})`);

	// Advance the start position so the next event calculates a delta from here.
	canvas.mouseStart = currentMousePosition;
	canvas.transform = [a, b, c, d, x, y];
}

function endPan(e) {
	document.removeEventListener("mousemove", onPan);
	document.removeEventListener("mouseup", endPan);
	canvas = {};
	startMomentum();
}

// ── Touch pan & pinch zoom ────────────────────────────────────────────────────
// 1 finger  → pan        (mirrors mouse pan logic)
// 2 fingers → pinch zoom (mirrors scroll-wheel zoom logic)

function touchStart(e) {
	e.preventDefault();
	stopMomentum();
	cancelFrameAnimation();

	const sctm = document.getElementById("main").getScreenCTM();

	if (e.touches.length === 1) {
		// Single finger: start a pan session identical to panStart.
		const { clientX, clientY } = e.touches[0];
		const transformed = viewPortToElementCoordinateSpaceTransformation(clientX, clientY, sctm);
		canvas = { mouseStart: transformed, transform: getTransform(), sctm, lastMoveTime: performance.now() };
	} else if (e.touches.length === 2) {
		// Second finger added: record the current inter-finger distance as the
		// baseline for computing the zoom ratio on subsequent move events.
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		canvas.lastPinchDistance = Math.hypot(dx, dy);
		canvas.sctm = sctm;
	}

	document.addEventListener("touchmove", onTouchMove, { passive: false });
	document.addEventListener("touchend", onTouchEnd);
}

function onTouchMove(e) {
	e.preventDefault();

	if (e.touches.length === 1 && canvas.mouseStart) {
		// ── 1-finger pan: same math as onPan ─────────────────────────────────────
		const { clientX, clientY } = e.touches[0];
		const now = performance.now();
		const currentPos = viewPortToElementCoordinateSpaceTransformation(clientX, clientY, canvas.sctm);
		const [a, b, c, d, translateX, translateY] = canvas.transform;

		const mouseDelta = {
			x: (currentPos.x - canvas.mouseStart.x) * scale,
			y: (currentPos.y - canvas.mouseStart.y) * scale,
		};

		trackVelocity(now - (canvas.lastMoveTime ?? now), mouseDelta.x, mouseDelta.y);
		canvas.lastMoveTime = now;

		const { x, y } = constrainPan(translateX + mouseDelta.x, translateY + mouseDelta.y, scale);
		document.getElementById("main").setAttribute("transform", `matrix(${a}, ${b}, ${c}, ${d}, ${x}, ${y})`);
		canvas.mouseStart = currentPos;
		canvas.transform = [a, b, c, d, x, y];

	} else if (e.touches.length === 2) {
		// ── 2-finger pinch zoom: same math as onZoom ─────────────────────────────
		// The zoom factor is the ratio of the current inter-finger distance to the
		// previous one. Spreading fingers apart gives a ratio > 1 (zoom in);
		// pinching gives a ratio < 1 (zoom out). This is analogous to the sign of
		// deltaY in the wheel handler.
		//
		// The midpoint between the two fingers serves as the focal point (equivalent
		// to the cursor position in onZoom). See onZoom for a full explanation of
		// the zoom-toward-point translation math.
		//
		// Momentum is not tracked during pinch — velocity is reset on release below
		// so a prior 1-finger flick doesn't bleed into or survive a pinch gesture.
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		const newDist = Math.hypot(dx, dy);

		const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
		const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
		const sctm = document.getElementById("main").getScreenCTM();
		const { x, y } = viewPortToElementCoordinateSpaceTransformation(midX, midY, sctm);

		const [a, b, c, d, oldPanX, oldPanY] = getTransform();
		const currentScale = a;

		let newScale = currentScale * (newDist / (canvas.lastPinchDistance || newDist));
		newScale = Math.max(1, Math.min(8, newScale));

		const scaleDifference = newScale - currentScale;
		const newPanX = oldPanX - x * scaleDifference;
		const newPanY = oldPanY - y * scaleDifference;

		scale = newScale;
		const { x: cx, y: cy } = constrainPan(newPanX, newPanY, newScale);
		document.getElementById("main").setAttribute("transform", `matrix(${newScale}, ${b}, ${c}, ${newScale}, ${cx}, ${cy})`);

		canvas.lastPinchDistance = newDist;
		velocity = { x: 0, y: 0 };
	}
}

function onTouchEnd(e) {
	if (e.touches.length === 0) {
		// All fingers lifted — tear down listeners, clear session state, and let
		// any accumulated velocity carry the pan forward with a decaying glide.
		canvas = {};
		document.removeEventListener("touchmove", onTouchMove);
		document.removeEventListener("touchend", onTouchEnd);
		startMomentum();
	} else if (e.touches.length === 1) {
		// One finger lifted after a pinch: transition seamlessly into a pan session.
		// Resetting mouseStart to the remaining finger's position prevents the first
		// pan move from producing a large spurious jump. Velocity was already reset
		// during the pinch, so this doesn't inherit any pinch-driven motion.
		const touch = e.touches[0];
		const sctm = document.getElementById("main").getScreenCTM();
		const transformed = viewPortToElementCoordinateSpaceTransformation(touch.clientX, touch.clientY, sctm);
		canvas.mouseStart = transformed;
		canvas.transform = getTransform();
		canvas.sctm = sctm;
		canvas.lastMoveTime = performance.now();
		delete canvas.lastPinchDistance;
	}
}

// ── Scroll-wheel zoom ─────────────────────────────────────────────────────────

function onZoom(e) {
	e.preventDefault();

	// A zoom while momentum or a frame-to-path animation is still running would
	// fight with them, so cancel both — the scroll gesture is the new intent.
	stopMomentum();
	cancelFrameAnimation();

	// Convert the cursor position to element space to identify which point in the
	// map the user is hovering over — this becomes the fixed focal point for zoom.
	const { clientX, clientY } = e;
	const sctm = document.getElementById("main").getScreenCTM();
	const { x, y } = viewPortToElementCoordinateSpaceTransformation(clientX, clientY, sctm);

	const [a, b, c, d, oldPanX, oldPanY] = getTransform();
	const currentScale = a;

	// Scale by ±10 % per scroll tick, clamped to [1×, 8×].
	const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
	const newScale = Math.max(1, Math.min(8, currentScale * zoomFactor));

	// Zoom-toward-cursor math:
	// The SVG transform maps element coordinates to screen pixels as:
	//   screen = scale * element + pan
	//
	// For the focal point (x, y) to stay fixed on screen, its screen coordinate
	// must be the same before and after the scale change:
	//   scale_old * x + pan_old  =  scale_new * x + pan_new
	//
	// Solving for pan_new:
	//   pan_new = pan_old + x * (scale_old - scale_new)
	//           = pan_old - x * scaleDifference
	const scaleDifference = newScale - currentScale;
	const newPanX = oldPanX - x * scaleDifference;
	const newPanY = oldPanY - y * scaleDifference;

	scale = newScale;
	const { x: constrainedX, y: constrainedY } = constrainPan(newPanX, newPanY, newScale);
	document.getElementById("main").setAttribute(
		"transform",
		`matrix(${newScale}, ${b}, ${c}, ${newScale}, ${constrainedX}, ${constrainedY})`,
	);
}

// ── Pan boundary enforcement ──────────────────────────────────────────────────

function constrainPan(x, y, scale) {
	// Clamps the translation so the user can never pan past the edge of the map.
	//
	// The SVG translation (e, f) expresses how far the canvas origin has shifted
	// in screen pixels. For the map to stay fully on-screen:
	//
	//   Upper bound (maxPan ≈ 0):
	//     Translation > 0 shifts the canvas right/down, revealing empty space on
	//     the left/top edge. We allow a small padding overshoot for visual comfort.
	//
	//   Lower bound (minPan = canvasDim - canvasDim * scale):
	//     At scale > 1 the rendered canvas is larger than the viewport. The lower
	//     bound is negative, representing the maximum left/up shift before the
	//     right/bottom edge of the map would leave the viewport.
	//
	//   Example at 2× zoom on a 1900 px canvas:
	//     minPanX = 1900 - 1900×2 - 10 = -1910  (can shift up to 1910 px left)
	//     maxPanX = 10                           (10 px slack to the right)
	let constrainedX = x;
	let constrainedY = y;

	if (scale < 0.5) {
		return { x: 0, y: 0 };
	}

	const padding = 10;
	const maxPanX = padding;
	const maxPanY = padding;
	const minPanX = canvasWidth - canvasWidth * scale - padding;
	const minPanY = canvasHeight - canvasHeight * scale - padding;

	if (x < minPanX) constrainedX = minPanX;
	else if (x > maxPanX) constrainedX = maxPanX;

	if (y < minPanY) constrainedY = minPanY;
	else if (y > maxPanY) constrainedY = maxPanY;

	return { x: constrainedX, y: constrainedY };
}

// ── SVG transform helpers ─────────────────────────────────────────────────────

function getTransform() {
	// Reads the current transform on the #main group and returns a flat 6-element
	// array [a, b, c, d, e, f] matching SVG matrix() notation:
	//   a, d = scaleX / scaleY    (equal — we only use uniform scaling)
	//   b, c = skewY / skewX      (always 0)
	//   e, f = translateX / translateY
	//
	// consolidate() collapses any stacked transform list into a single matrix and
	// returns null if no transform exists, in which case we return the identity.
	const main = document.getElementById("main");
	const consolidated = main.transform.baseVal.consolidate();
	if (!consolidated) {
		return [1, 0, 0, 1, 0, 0];
	}
	const matrix = consolidated.matrix;
	return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
}

function distance(p1, p2) {
	// Euclidean distance between two graph nodes, used to weight undirected edges.
	const dx = p1.xCoord - p2.xCoord;
	const dy = p1.yCoord - p2.yCoord;
	return Math.sqrt(dx * dx + dy * dy);
}

// ── Pathfinding API ───────────────────────────────────────────────────────────

export const PathfindingAPI = {
	findPath(startNode, endNode) {
		if (startNode === endNode) {
			frameToNodes([startNode]);
			return [startNode];
		}

		const [dists, prev] = Dijkstras(myGraph, startNode);
		const path = [];

		// A building may have multiple entrance connectors. Select the one with the
		// shortest total distance from the source so the path ends at the optimal
		// entry point rather than an arbitrary one.
		const entranceNodes = myGraph.getNeighborNodes(myGraph.getNode(endNode));
		let min = entranceNodes[0];
		for (const currentNode of entranceNodes) {
			if (dists[min.getName()] > dists[currentNode.getName()]) {
				min = currentNode;
			}
		}

		// Walk the prev-pointer chain back from the best entrance to the source.
		let current = min;
		while (current.getName() !== myGraph.getNode(startNode).getName()) {
			path.unshift(current.getName());
			current = myGraph.getNode(prev[current.getName()]);
		}

		// Frame the viewport around the full route, including the true start/end
		// (path itself only contains the intermediate + entrance nodes).
		frameToNodes([startNode, ...path, endNode]);

		return path;
	},
};