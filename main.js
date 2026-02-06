//Event listener reads the svg into memory and loads it into the html as apart of the svg container

import { graph, Dijkstras } from "./graph.js";
//global variable to hold transformation information
let canvas = {};
let canvasHeight;
let canvasWidth;
let scale = 1;
let myGraph;
document.addEventListener("DOMContentLoaded", () => {
  fetch("vector_map.svg")
    .then((response) => response.text())
    .then(async (svgContent) => {
      const parser = new DOMParser();
      const fileContent = parser.parseFromString(svgContent, "image/svg+xml");
      myGraph = await loadNodes(fileContent);
      const svg = fileContent.querySelector("svg");
      canvasHeight = svg.height.baseVal.value;
      canvasWidth = svg.width.baseVal.value;
      console.log(svg);
      console.log(canvasWidth, canvasHeight);
      //create line group for the line overlay to be displayed
      const linesGroup = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "g",
      );
      linesGroup.id = "lines";
      //insert the line group at the top of the svg container
      //we use appendChild because we want the lines to be overlayed above the nodes
      //which means that they need to be a group placed/ drawn after the node group which is #visible_ellipses
      // svg.appendChild(linesGroup, svg.querySelector("#main"));
      svg.querySelector("#main").appendChild(linesGroup);
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

      // console.log(myGraph);
      // console.log(Dijkstras(myGraph, "node-NAS"));
    });
});

function viewPortToElementCoordinateSpaceTransformation(
  x,
  y,
  sctm = null,
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
  // const sctm = document.getElementById("canvas").getScreenCTM();
  const transformed = viewPortToElementCoordinateSpaceTransformation(
    clientX,
    clientY,
    sctm,
    // currentTransformation
  );
  // console.log("transformed: " + transformed.x, transformed.y);
  //implicit global variables
  canvas = { mouseStart: transformed, transform: currentTransformation, sctm };
  document.addEventListener("mousemove", onPan);
  document.addEventListener("mouseup", endPan);
  // document.getElementById("svg-container").addEventListener("mousemove", onPan);
  // document.getElementById("svg-container").addEventListener("mouseup", endPan);
}

function constrainPan(x, y, scale) {
  //base case where everything fits in the viewport window.
  let constrainedX = x;
  let constrainedY = y;
  if (scale < 0.5) {
    return { x: 0, y: 0 };
  }
  const padding = 10;
  const maxPanX = 0 + padding;
  const maxPanY = 0 + padding;
  const minPanX = canvasWidth - canvasWidth * scale - padding;
  const minPanY = canvasHeight - canvasHeight * scale - padding;

  if (x < minPanX) {
    constrainedX = minPanX;
  } else if (x > maxPanX) {
    constrainedX = maxPanX;
  }

  if (y < minPanY) {
    constrainedY = minPanY;
  } else if (y > maxPanY) {
    constrainedY = maxPanY;
  }

  return { x: constrainedX, y: constrainedY };

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
    sctm,
  );
  const [a, b, c, d, oldPanX, oldPanY] = getTransform();
  const currentScale = a;

  const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
  let newScale = currentScale * zoomFactor;

  console.log(a);

  newScale = Math.max(1, Math.min(2, newScale));
  const scaleDifference = newScale - currentScale;
  const offsetX = -(x * scaleDifference);
  const offsetY = -(y * scaleDifference);

  const newPanX = oldPanX + offsetX;
  const newPanY = oldPanY + offsetY;

  scale = newScale;
  const {
    x: constrainedX,
    y: constrainedY
  } = constrainPan(newPanX, newPanY, newScale);
  document
    .getElementById("main")
    .setAttribute(
      "transform",
      `matrix(${newScale}, ${b}, ${c}, ${newScale}, ${constrainedX}, ${constrainedY})`,
    );
}

//when you pan you need to claculaute the distance between where the mouse started and where it ended.
//but if you scale up the svg, when you calculate the distance,
function onPan(e) {
  const { clientX, clientY } = e;
  // console.log(canvas.transform);
  const currentMousePosition = viewPortToElementCoordinateSpaceTransformation(
    clientX,
    clientY,
    canvas.sctm,
  );
  const [a, b, c, d, translateX, translateY] = canvas.transform;
  const mouseDelta = {
    x: (currentMousePosition.x - canvas.mouseStart.x) * scale,
    y: (currentMousePosition.y - canvas.mouseStart.y) * scale,
  };

  const horizontalTranslation = translateX + mouseDelta.x;
  const verticalTranslation = translateY + mouseDelta.y;

  const { x, y } = constrainPan(
    horizontalTranslation,
    verticalTranslation,
    scale,
  );
  document
    .getElementById("main")
    .setAttribute("transform", `matrix(${a}, ${b}, ${c}, ${d}, ${x}, ${y})`);
  // document
  // 	.getElementById("main")
  // 	.setAttribute(
  // 		"transform",
  // 		`matrix(${a}, ${b}, ${c}, ${d}, ${horizontalTranslation}, ${verticalTranslation})`
  // 	);
  canvas.mouseStart = currentMousePosition;
  canvas.transform = [a, b, c, d, x, y];
}

function endPan(e) {
  canvas = {};
  document.removeEventListener("mousemove", onPan);
  document.removeEventListener("mouseup", endPan);

  //   document
  //     .getElementById("svg-container")
  //     .removeEventListener("mousemove", onPan);
  //   document
  //     .getElementById("svg-container")
  //     .removeEventListener("mouseup", endPan);
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
  let mapGraph = new graph();

  const nodes = fileContent.querySelectorAll("circle");
  //while loop iterates through all svg node components and adds the nodes to memory as a part of a graph
  for (const node of nodes) {
    if (node.id.includes("node")) {
      mapGraph.createNode(
        node.getAttribute("cx"),
        node.getAttribute("cy"),
        node.id,
      );
    } else {
      continue;
    }
  }
  console.log(mapGraph);
  //load edge data
  //DO WE NEED TO ALTER THE CODE to PREVEnt DUPLICATE EDGES FROM BEING CREATED???
  //EX: It's a problem if we have an edge from a to b and also from b to a because those are the same
  const edges = await fetch("./edges.json").then((response) => response.json());
  for (let edge of edges.edges) {
    let edgeWeight;
    let isDirected = false;
    if (edge.type === "virtual") {

      isDirected = true;
      edgeWeight = 0;
    } else {
      edgeWeight = distance(
        mapGraph.getNode(edge.from),
        mapGraph.getNode(edge.to),
      );
    }

    mapGraph.addEdge(edgeWeight, edge.from, edge.to, isDirected);
  }
  console.log(mapGraph);
  return mapGraph;
}
export const PathfindingAPI = {
  findPath(startNode, endNode) {
    if (startNode === endNode) {
      return [startNode]; // or return [] if you want no path
    }
    const [dists, prev] = Dijkstras(myGraph, startNode);
    console.log("This is prev", prev);
    const path = [];


    let entranceNodes;
    console.log(myGraph.getNode(endNode).edges, myGraph.getNode(endNode));

    entranceNodes = myGraph.getNeighborNodes(myGraph.getNode(endNode));
    console.log(entranceNodes);


    let min = entranceNodes[0];
    for (const currentNode of entranceNodes) {
        if (dists[min.getName()] > dists[currentNode.getName()]) {
          min = currentNode;
        } else {
          continue;
        }
    }




    // let entranceNodes = [] 
    // endNode.getOppositeNodes()

          let current = min; 
          console.log(current);
      //  it correctly ends at LRCE1 and has a null prev
      console.log(current.getName(), myGraph.getNode(startNode).getName());
      while (current.getName() !== myGraph.getNode(startNode).getName()) {
      // // if (current.includes("vnode")) {
      //   current = prev[current]; 

      //   continue;
      // }
      
      path.unshift(current.getName());

      current = myGraph.getNode(prev[current.getName()]);
      console.log(current);
    }
    return path;
  },
};
