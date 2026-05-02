import { beforeEach, describe, expect, it } from 'vitest';
import { environment, startRoll } from './testFramework';

describe('mock20 dice parser', () => {
  beforeEach(() => {
    environment.attributes = {};
    environment.diceStack = {};
  });

  it('honors keep-highest syntax in roll expressions', async () => {
    environment.diceStack[6] = [4, 6, 2];

    const roll = await startRoll('&{template:default} {{result=[[3d6k1+2]]}}');

    expect(roll.results.result.dice).toEqual([2, 6, 4]);
    expect(roll.results.result.result).toBe(8);
  });

  it('honors keep-lowest syntax in roll expressions', async () => {
    environment.diceStack[6] = [4, 1, 6];

    const roll = await startRoll('&{template:default} {{result=[[3d6kl1+2]]}}');

    expect(roll.results.result.dice).toEqual([6, 1, 4]);
    expect(roll.results.result.result).toBe(3);
  });

  it('honors keep-highest longhand syntax in roll expressions', async () => {
    environment.diceStack[6] = [4, 6, 2];

    const roll = await startRoll('&{template:default} {{result=[[3d6kh1+2]]}}');

    expect(roll.results.result.dice).toEqual([2, 6, 4]);
    expect(roll.results.result.result).toBe(8);
  });

  it('honors drop-lowest syntax in roll expressions', async () => {
    environment.diceStack[6] = [4, 6, 2];

    const roll = await startRoll('&{template:default} {{result=[[3d6d1+2]]}}');

    expect(roll.results.result.dice).toEqual([2, 6, 4]);
    expect(roll.results.result.result).toBe(12);
  });

  it('honors drop-highest syntax in roll expressions', async () => {
    environment.diceStack[6] = [4, 1, 6];

    const roll = await startRoll('&{template:default} {{result=[[3d6dh1+2]]}}');

    expect(roll.results.result.dice).toEqual([6, 1, 4]);
    expect(roll.results.result.result).toBe(7);
  });

  it('honors keeping multiple highest dice', async () => {
    environment.diceStack[6] = [3, 5, 1, 6];

    const roll = await startRoll('&{template:default} {{result=[[4d6k2+1]]}}');

    expect(roll.results.result.dice).toEqual([6, 1, 5, 3]);
    expect(roll.results.result.result).toBe(12);
  });

  it('honors keeping multiple lowest dice', async () => {
    environment.diceStack[6] = [3, 5, 1, 6];

    const roll = await startRoll('&{template:default} {{result=[[4d6kl2+1]]}}');

    expect(roll.results.result.dice).toEqual([6, 1, 5, 3]);
    expect(roll.results.result.result).toBe(5);
  });

  it('honors dropping multiple lowest dice', async () => {
    environment.diceStack[6] = [3, 5, 1, 6];

    const roll = await startRoll('&{template:default} {{result=[[4d6d2+1]]}}');

    expect(roll.results.result.dice).toEqual([6, 1, 5, 3]);
    expect(roll.results.result.result).toBe(12);
  });

  it('honors dropping multiple highest dice', async () => {
    environment.diceStack[6] = [3, 5, 1, 6];

    const roll = await startRoll('&{template:default} {{result=[[4d6dh2+1]]}}');

    expect(roll.results.result.dice).toEqual([6, 1, 5, 3]);
    expect(roll.results.result.result).toBe(5);
  });

  it('preserves existing behavior for rolls without keep modifiers', async () => {
    environment.diceStack[6] = [4, 6, 2];

    const roll = await startRoll('&{template:default} {{result=[[3d6+2]]}}');

    expect(roll.results.result.dice).toEqual([2, 6, 4]);
    expect(roll.results.result.result).toBe(14);
  });
});
