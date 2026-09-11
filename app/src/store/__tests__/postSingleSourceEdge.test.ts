import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/store/useCanvasStore';

describe('Post node source guard', () => {
  beforeEach(() => {
    useCanvasStore.getState().createCanvas('post-source-guard');
  });

  it('keeps only the latest source on post-input', () => {
    const imageA = useCanvasStore.getState().addNode('image', { x: 0, y: 0 });
    const imageB = useCanvasStore.getState().addNode('image', { x: 0, y: 280 });
    const postNode = useCanvasStore.getState().addNode('post', { x: 420, y: 120 });

    useCanvasStore.getState().addEdge(imageA, postNode, {
      sourceHandle: 'media-output',
      targetHandle: 'post-input',
    });
    useCanvasStore.getState().addEdge(imageB, postNode, {
      sourceHandle: 'media-output',
      targetHandle: 'post-input',
    });

    const incoming = useCanvasStore.getState().canvas!.edges.filter((edge) => (
      edge.target === postNode && edge.targetHandle === 'post-input'
    ));

    expect(incoming).toHaveLength(1);
    expect(incoming[0].source).toBe(imageB);
  });
});
