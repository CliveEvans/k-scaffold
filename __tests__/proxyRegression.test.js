import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { environment, k, setAttrs, setSectionOrder } from './testFramework';

// Event handlers (on('change:x', accessSheet)) are registered via setTimeout(0) in listeners.js.
// Wait once at suite start so environment.triggers is populated before any test fires an event.
const waitForHandlers = () => new Promise((resolve) => setTimeout(resolve, 10));

const getTrigger = (eventName) => {
  const entry = environment.triggers.find((t) => {
    const names = t.trigger.split(' ');
    return names.includes(eventName);
  });
  if (!entry) throw new Error(`No trigger registered for ${eventName}. Registered: ${environment.triggers.map((t) => t.trigger).join(', ')}`);
  return entry.func;
};

const fireChange = (attrName) => {
  const listener = getTrigger(`change:${attrName}`);
  listener({ sourceAttribute: attrName, newValue: environment.attributes[attrName], previousValue: environment.attributes[attrName] });
};

const fireClick = (actionName) => {
  const listener = getTrigger(`clicked:${actionName}`);
  listener({ sourceAttribute: `clicked:${actionName}`, triggerName: `clicked:${actionName}` });
};

describe('attribute_proxy regression fixes', () => {
  beforeAll(async () => {
    await waitForHandlers();
  });
  beforeEach(() => {
    environment.proxyRegressionResults = {};
  });

  it('fix #1/#2: set trap does not queue same-value writes', () => {
    environment.attributes.proxy_noop_val = '0';
    fireChange('proxy_noop_val');
    const result = environment.proxyRegressionResults.noopWrite;
    expect(result).toBeDefined();
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
    expect(result.hasKey).toBe(false);
  });

  it('fix #3: callback passed to attributes.set() survives cascade queue processing', () => {
    environment.attributes.proxy_cascade_source = '0';
    environment.attributes.proxy_cascade_target = '0';
    fireChange('proxy_cascade_source');
    const result = environment.proxyRegressionResults.cascadeCallback;
    expect(result).toBeDefined();
    expect(result.cbCount).toBe(1);
  });

  it('fix #4: sort() defers setSectionOrder until after setAttrs commit', () => {
    setAttrs.mockClear();
    setSectionOrder.mockClear();
    fireClick('proxy-sort-trigger');
    expect(environment.proxyRegressionResults.sortDefersOrder).toEqual({triggered: true});
    // Both mocks must have been called during the event handling.
    expect(setSectionOrder.mock.invocationCallOrder.length).toBeGreaterThan(0);
    expect(setAttrs.mock.invocationCallOrder.length).toBeGreaterThan(0);
    // The first setAttrs call must precede the first setSectionOrder call.
    // Under the bug, sort() fires setSectionOrder synchronously before setAttrs commits.
    // Under the fix, setSectionOrder is scheduled via attributes.set({callback}) so setAttrs fires first.
    const firstSetAttrs = setAttrs.mock.invocationCallOrder[0];
    const firstSetSectionOrder = setSectionOrder.mock.invocationCallOrder[0];
    expect(firstSetAttrs).toBeLessThan(firstSetSectionOrder);
  });

  it('fix #5: non-numeric stored value is not overridden by numeric defaultValue', () => {
    environment.attributes.proxy_whisper = '/w gm';
    fireChange('proxy_whisper');
    const result = environment.proxyRegressionResults.readWhisper;
    expect(result).toBeDefined();
    expect(result.value).toBe('/w gm');
  });
});
