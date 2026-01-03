//*notes
/**graph will be loaded via a json file that queries all of the node components. We no longer need the deprecated load functions from our mvp.
 *
 *the way this works is that as soon as dom content loads, the graph is going to be loaded based upon the contents of the svg. The svg is used botht o render the fron end and also is the source of truth for the graph on the back end. Node names are the same and are simply labeled node-1, node-2 etc. Everything else should be the same in terms of calculating the shortest route and the expected outputs of the functions. 

 the only things I could see changing are some small implementation changes that may be required to account for the new method we are using for loading our graph into memory


 the things we definitely need to add are transformation functions that are used to scale and pan the svg and the paths that are drawn on the screen. 




 DJIKSTRA SHOULD NOT RUN if the start and end locatinos are equivalent so this is a sort of edge case to consider.
 * 
 * 
 * One thing that will need to be added is a way to calculate distance on the fly between points. Actual distances shouldnt matter here as ultimately pixel distances should be accurate enough for determining how far paths are from each other.
 *
 *
 *
 */

class graph {
  constructor() {
    this.nodes = [];
    this.numNodes = 0;
    this.edges = [];
  }

  getNodes() {
    return this.nodes;
  }

  getNode(nodeName) {
    for (const curr_node of this.nodes) {
      if (curr_node.getName() === nodeName) {
        return curr_node;
      }
    }
    throw new Error("Node not found!");
  }

  getDistanceBetween(node1Name, node2Name) {
    const node1 = this.getNode(node1Name);
    const node2 = this.getNode(node2Name);
    return node1.getDistanceTo(node2);
  }

  createNode(xCoord, yCoord, nodeName) {
    const newNode = new graphNode(xCoord, yCoord, nodeName);
    this.nodes.push(newNode);
    this.numNodes += 1;
    //console.log(this.nodes);
    // Later implement test for duplicates
  }

  deleteNode(nodeName) {
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].getName() === nodeName) {
        if (i === this.nodes.length - 1) {
          this.nodes.pop();
          this.numNodes -= 1;
        } else {
          console.log(this.nodes.length);
          this.nodes[i] = this.nodes[this.nodes.length - 1];
          this.nodes.pop();
          this.numNodes -= 1;
        }
      }
    }
  }

  getNeighborNodes(node) {
    let neighborNodes = [];
    for (let i = 0; i < node.edges.length; i++) {
      if (
        node.edges[i].node1.getName() === node.getName() ||
        node.edges[i].node2.getName() === node.getName()
      ) {
        neighborNodes.push(node.edges[i].getOppositeNode(node));
      } else {
        console.log("no");
      }
    }
    return neighborNodes;
  }

  addEdge(weight, node1Name, node2Name) {
    const node1 = this.getNode(node1Name);
    const node2 = this.getNode(node2Name);
    const newEdge = new graphEdge(weight, node1, node2);
    node1.addEdge(newEdge);
    node2.addEdge(newEdge);
    this.edges.push(newEdge);
  }
  getEdges() {
    return this.edges;
  }
}

class graphNode {
  constructor(xCoord, yCoord, nodeName) {
    this.xCoord = xCoord;
    this.yCoord = yCoord;
    this.name = nodeName;
    this.edges = [];
  }

  addEdge(edge) {
    this.edges.push(edge);
  }
  getName() {
    return this.name;
  }
  getDistanceTo(node) {
    //should this function assume that all nodes being requested
    //to are properly connected?
    for (const edge of this.edges) {
      if (
        edge.getNodes().includes(this.name) &&
        edge.getNodes().includes(node.getName())
      ) {
        return edge.weight;
      } else {
        continue;
      }
    }
    return -1;
  }
}

class graphEdge {
  constructor(weight, node1, node2) {
    this.weight = weight;
    this.node1 = node1;
    this.node2 = node2;
  }

  getNodes() {
    //returns the names of the nodes the edge attaches
    return [this.node1.getName(), this.node2.getName()];
  }
  getOppositeNode(node) {
    if (
      node.getName() != this.node1.getName() &&
      node.getName() != this.node2.getName()
    ) {
      throw new Error("Invalid node");
    }
    return node.getName() === this.node1.getName() ? this.node2 : this.node1;
  }
}

function Dijkstras(graph, sourceNodeName) {
  let queue = [];
  let prev = {};
  let dists = {};

  for (const node of graph.getNodes()) {
    dists[node.getName()] = Infinity;
    prev[node.getName()] = null;
  }

  dists[sourceNodeName] = 0;
  queue.push([0, graph.getNode(sourceNodeName)]);

  //  queue.push([1, "abc"]);
  // queue.push([5, "blabhba"]);
  // queue.push([3, "testing333"]);
  // queue.push([8, "fdsfsdfdd"]);
  // queue.sort((b, a) => a[0] - b[0]);
  // queue.pop()
  //console.log("Sorted queue: ", queue);

  while (queue.length > 0) {
    queue.sort((a, b) => {
      a[0] - b[0];
    });
    const [currentDist, currentNode] = queue.pop();
    if (currentDist > dists[currentNode.getName()]) {
      continue;
    }
    const currentNodeNeighbors = graph.getNeighborNodes(currentNode);
    for (neighbor of currentNodeNeighbors) {
      const weight = graph.getDistanceBetween(
        currentNode.getName(),
        neighbor.getName()
      );
      const newDist = dists[currentNode.getName()] + weight;
      if (newDist < dists[neighbor.getName()]) {
        dists[neighbor.getName()] = newDist;
        prev[neighbor.getName()] = currentNode.getName();
        queue.push([newDist, neighbor]);
      }
    }
  }

  return [dists, prev];
}
