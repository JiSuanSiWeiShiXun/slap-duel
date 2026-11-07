import { Node, Layers, MeshRenderer, Mesh, Material, Color, primitives, utils } from 'cc';

/** Original office set. This owner never creates, moves or disposes actors. */
export class ArenaView {
    private readonly root = new Node('OfficeArena');
    private readonly meshes: Mesh[] = [];
    private readonly materials: Material[] = [];

    constructor(parent: Node) {
        parent.addChild(this.root);
        this.box('Floor', [7.2, .16, 4.6], [0, -.13, -.3], '#3B505B');
        // Quiet tile seams and the open central aisle keep hands and faces legible.
        for (const x of [-2.4, -1.2, 0, 1.2, 2.4]) this.box('FloorJoint', [.012, .006, 4.5], [x, -.045, -.3], '#435A65');
        for (const z of [-1.8, -.6, .6, 1.8]) this.box('FloorJoint', [7.1, .006, .012], [0, -.045, z], '#435A65');
        this.box('BackBoundary', [7.2, .76, .12], [0, .32, -2.55], '#2D424F');
        this.box('WindowBand', [6.8, .25, .04], [0, .52, -2.47], '#49616C');
        for (const x of [-2.3, 0, 2.3]) this.box('WindowMullion', [.035, .65, .05], [x, .35, -2.43], '#334B58');
        for (const x of [-3.05, 3.05]) {
            this.box('SidePartition', [.12, .6, 3.9], [x, .22, -.35], '#304652');
            this.box('Cabinet', [.8, .64, .58], [x * .86, .27, -1.87], '#405762');
            this.box('CabinetTop', [.86, .06, .62], [x * .86, .62, -1.87], '#60717A');
            this.box('PaperTray', [.32, .06, .24], [x * .86, .68, -1.87], '#7D898D');
        }
    }

    private box(name: string, size: number[], position: number[], color: string): void {
        const node = new Node(name);
        this.root.addChild(node); node.layer = Layers.Enum.DEFAULT;
        node.setPosition(position[0], position[1], position[2]);
        node.setScale(size[0], size[1], size[2]);
        const renderer = node.addComponent(MeshRenderer), mesh = utils.createMesh(primitives.box());
        renderer.mesh = mesh; this.meshes.push(mesh);
        const material = new Material(); material.initialize({ effectName: 'builtin-unlit' });
        material.setProperty('mainColor', new Color(color)); renderer.setMaterial(material, 0);
        this.materials.push(material);
    }

    dispose(): void {
        this.root.destroy();
        for (const mesh of this.meshes) mesh.destroy();
        for (const material of this.materials) material.destroy();
        this.meshes.length = this.materials.length = 0;
    }
}
