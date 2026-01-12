//Event listener reads the svg into memory and loads it into the html as apart of the svg container

import { graph } from "./graph.js";
//global variable to hold transformation information
let canvas = {};
let canvasHeight;
let canvasWidth;
document.addEventListener("DOMContentLoaded", () => {
	fetch("Untitled.svg")
		.then((response) => response.text())
		.then(async (svgContent) => {
			const parser = new DOMParser();
			const fileContent = parser.parseFromString(svgContent, "image/svg+xml");
			await loadNodes(fileContent);
			const svg = fileContent.querySelector("svg");
			canvasHeight = svg.height.baseVal.value;
			canvasWidth = svg.width.baseVal.value;
			console.log(svg);
			console.log(canvasWidth, canvasHeight);
			//create line group for the line overlay to be displayed
			const linesGroup = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"g"
			);
			linesGroup.id = "lines";
			//insert the line group at the top of the svg container
			//we use appendChild because we want the lines to be overlayed above the nodes
			//which means that they need to be a group placed/ drawn after the node group which is #visible_ellipses
			svg.appendChild(linesGroup, svg.querySelector("#main"));
			document.getElementById("svg-container").appendChild(svg);
			//set transform to identity matrix
			svg
				.querySelector("#main")
				.setAttribute("transform", "matrix(1, 0, 0, 1, 0, 0)");
			//scale svg to container size
			svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
			svg.style.width = "100%";
			svg.style.height = "100%";
			getTransform();
		});
});

function viewPortToElementCoordinateSpaceTransformation(
	x,
	y,
	sctm = null
	// elementTransform = null
) {
	const p = new DOMPoint(x, y);

	let screenCTM;
	if (sctm === null) {
		screenCTM = document.getElementById("main").getScreenCTM();
	} else {
		screenCTM = sctm;
	}

	const inverseScreenTransform = screenCTM.inverse();
	const transformedPoint = p.matrixTransform(inverseScreenTransform);
	return { x: transformedPoint.x, y: transformedPoint.y };
}

//start of pan logic: process information before user lets go of the mouse
function panStart(e) {
	const { clientX, clientY } = e;
	console.log(clientX, clientY);
	const currentTransformation = getTransform();

	const sctm = document.getElementById("main").getScreenCTM();
	const transformed = viewPortToElementCoordinateSpaceTransformation(
		clientX,
		clientY,
		sctm
		// currentTransformation
	);
	// console.log("transformed: " + transformed.x, transformed.y);
	//implicit global variables
	canvas = { mouseStart: transformed, transform: currentTransformation, sctm };
	document.getElementById("svg-container").addEventListener("mousemove", onPan);
	document.getElementById("svg-container").addEventListener("mouseup", endPan);
}

function constrainPan(x, y, scale) {
	//base case where everything fits in the viewport window.
	if (scale <= 1) {
		return { x: 0, y: 0 };
	}
	const maxPanX = 0;
	const maxPanY = 0;
	//how to contstrain how far someone can pan?
	//ex: lets assume we are at 2x zoom. This means effective area we can pan is 2x the viewbox size. So if our viewbox is at 1000 then at a 2x scale our new space is effectively
	//2000. This means that at any given point someone should not be able to pan past an x value of 1000. The reason for this is because if x=0 it means no horizontal
	//translation has occurred and we are viewing the far left of the image. 0 is effectively th eupper bound. the lower bound is the viewport size - the scaled viewport size.
}

function onZoom(e) {
	e.preventDefault();
	const { clientX, clientY } = e;
	const sctm = document.getElementById("main").getScreenCTM();
	const { x, y } = viewPortToElementCoordinateSpaceTransformation(
		clientX,
		clientY,
		sctm
	);
	const [a, b, c, d, oldPanX, oldPanY] = getTransform();
	const currentScale = a;

	const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
	let newScale = currentScale * zoomFactor;

	newScale = Math.max(0.5, Math.min(4, newScale));
	const scaleDifference = newScale - currentScale;
	const offsetX = -(x * scaleDifference);
	const offsetY = -(y * scaleDifference);

	const newPanX = oldPanX + offsetX;
	const newPanY = oldPanY + offsetY;

	document
		.getElementById("main")
		.setAttribute(
			"transform",
			`matrix(${newScale}, ${b}, ${c}, ${newScale}, ${newPanX}, ${newPanY})`
		);
}
function onPan(e) {
	const { clientX, clientY } = e;
	console.log(canvas.transform);
	const currentMousePosition = viewPortToElementCoordinateSpaceTransformation(
		clientX,
		clientY,
		canvas.sctm
	);
	const [a, b, c, d, translateX, translateY] = canvas.transform;
	const mouseDelta = {
		x: currentMousePosition.x - canvas.mouseStart.x,
		y: currentMousePosition.y - canvas.mouseStart.y,
	};

	const horizontalTranslation = translateX + mouseDelta.x;
	const verticalTranslation = translateY + mouseDelta.y;

	document
		.getElementById("main")
		.setAttribute(
			"transform",
			`matrix(${a}, ${b}, ${c}, ${d}, ${horizontalTranslation}, ${verticalTranslation})`
		);
}

function endPan(e) {
	canvas = {};
	document
		.getElementById("svg-container")
		.removeEventListener("mousemove", onPan);
	document
		.getElementById("svg-container")
		.removeEventListener("mouseup", endPan);
}
function getTransform() {
	const main = document.getElementById("main");

	const consolidated = main.transform.baseVal.consolidate();
	//in case there is no transformation, .consolidate() returns null and we return the identity matrix
	if (!consolidated) {
		return [1, 0, 0, 1, 0, 0];
	}
	const matrix = consolidated.matrix;
	return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
}
document.getElementById("svg-container").addEventListener("wheel", onZoom);
document
	.getElementById("svg-container")
	.addEventListener("mousedown", panStart);

function distance(p1, p2) {
	const xDifference = p1.xCoord - p2.xCoord;
	const yDifference = p1.yCoord - p2.yCoord;
	const sumOfSquares = Math.pow(xDifference, 2) + Math.pow(yDifference, 2);
	return Math.sqrt(sumOfSquares);
}

async function loadNodes(fileContent) {
	let index = 1;
	let node;

	let mapGraph = new graph();

	//while loop iterates through all svg node components and adds the nodes to memory as a part of a graph
	while ((node = fileContent.getElementById(`node-${index}`))) {
		mapGraph.createNode(
			node.getAttribute("cx"),
			node.getAttribute("cy"),
			node.id
		);
		console.log({
			id: node.id,
			cx: node.getAttribute("cx"),
			cy: node.getAttribute("cy"),
			r: node.getAttribute("r"),
		});
		index++;
	}

	//load edge data
	//DO WE NEED TO ALTER THE CODE to PREVEnt DUPLICATE EDGES FROM BEING CREATED???
	//EX: It's a problem if we have an edge from a to b and also from b to a because those are the same
	const edges = await fetch("./edges.json").then((response) => response.json());
	for (let edge of edges.edges) {
		const edgeWeight = distance(
			mapGraph.getNode(edge.from),
			mapGraph.getNode(edge.to)
		);
		mapGraph.addEdge(edgeWeight, edge.from, edge.to);
	}
	console.log(mapGraph);
	return graph;
}
