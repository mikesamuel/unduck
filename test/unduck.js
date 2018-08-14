/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint id-length: ["error", { "exceptions": ["ud", "x", "y"] }] */
/* eslint array-element-newline: [0] */

'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const { unduck, DuckError } = require('../index.js');

describe('unduck', () => {
  const dateType = {
    classType: Date,
    properties: {
      type: {
        value: 'Date',
      },
      millis: {
        type: 'number',
      },
    },
    toConstructorArguments({ millis }) {
      return [ millis ];
    },
  };

  const millis = 1234; // eslint-disable-line no-magic-numbers

  it('scoping', () => {
    const ud = unduck.withTypes(dateType);

    const pojo = { type: 'Date', millis };

    const date = ud(pojo);
    expect(date instanceof Date).to.equal(true);
    expect(Number(date)).to.equal(millis);

    expect(() => unduck(pojo)).to.throw(DuckError, 'No types matching');

    // date and pojo are reference distinct
    expect(date.type).to.equal(undefined); // eslint-disable-line no-undefined
    expect(pojo.type).to.equal('Date');
  });
  it('not a date', () => {
    const ud = unduck.withTypes(dateType);
    expect(() => ud({ type: 'late', millis }))
      .to.throw(DuckError, 'Failed to convert property type using type Date');
  });
  it('extra junk', () => {
    const ud = unduck.withTypes(dateType);
    expect(() => ud({ type: 'Date', millis, 'foo': 'bar' }))
      .to.throw(DuckError, 'Duck type Date does not allow key foo');
  });
  it('bad toConstructorArgs', () => {
    const ud = unduck.withTypes({
      classType: Date,
      toConstructorArguments({ millis: x }) {
        // Should return an array
        return x;
      },
      properties: {
        millis: {},
      },
    });
    expect(() => ud({ millis })).to.throw(
      DuckError,
      'Failed to compute constructor arguments for Date');
  });
  it('bad toConstructorArgs out of 2', () => {
    const ud = unduck.withTypes({
      classType: Date,
      toConstructorArguments({ millis: x }) {
        // Should return an array
        return Number(x);
      },
      properties: {
        millis: {},
      },
    },
    {
      classType: class C {},
      toConstructorArguments() {
        throw new Error('Should not be called');
      },
      properties: {
        millis: { type: 'number' },
      },
    });
    expect(() => ud({ millis: '1234' })).to.throw(
      DuckError,
      [
        'Date: MissingDuckError: Failed to compute constructor arguments for Date',
        'C: MissingDuckError: Failed to convert property millis using type C',
      ].join('\n'));
  });
  it('constructor that throws', () => {
    class FooError extends Error {}

    // Should propagte right up.
    const ud = unduck.withTypes({
      classType: class Bad {
        constructor() {
          throw new FooError('BOO!');
        }
      },
      toConstructorArguments(x) {
        return [ x ];
      },
      properties: {
        x: {},
      },
    });

    expect(() => ud({ x: null })).to.throw(FooError, 'BOO!');
  });
  it('constructor that throws during recursive invocation', () => {
    class FooError extends Error {}

    // Should propagte right up.
    const ud = unduck.withTypes({
      classType: class Bad {
        constructor() {
          throw new FooError('BOO!');
        }
      },
      toConstructorArguments(x) {
        return [ x ];
      },
      properties: {
        x: {},
      },
    },
    {
      classType: class Good {
        constructor(y) {
          this.y = y;
        }
      },
      toConstructorArguments({ y }) {
        return [ y ];
      },
      properties: {
        y: {},
      },
    });

    expect(() => ud({ y: { x: null } })).to.throw(FooError, 'BOO!');
  });
  describe('duplicates', () => {
    const typeA = {
      classType: class TypA {},
      toConstructorArguments: Array,
      properties: { x: {} },
    };
    const typeB = {
      classType: class TypB {},
      toConstructorArguments: Array,
      properties: { x: {} },
    };

    it('added twice', () => {
      const ud = unduck.withTypes(typeA, typeA);
      expect(ud({ x: 1 }) instanceof typeA.classType).to.equal(true);
    });
    it('added twice via separate invocations', () => {
      const ud = unduck.withTypes(typeA).withTypes(typeA);
      expect(ud({ x: 1 }) instanceof typeA.classType).to.equal(true);
    });
    it('indistinguishable duplicates', () => {
      const ud = unduck.withTypes(typeA, typeB);
      expect(() => ud({ x: 1 })).to.throw(
        DuckError, [ 'Duck hunt found multiple applicable types: TypA and TypB' ].join('\n'));
    });
  });
  it('primitive array', () => {
    // eslint-disable-next-line no-magic-numbers
    const arr = [ 0, 1, 2, 3, 'four', null, [ 6 ] ];
    const unducked = unduck(arr);

    expect(arr === unducked).to.equal(false);
    expect(arr).to.deep.equal(unducked);
  });
  it('array cycle detected', () => {
    const ud = unduck.withTypes(dateType);
    const arr = [];
    arr.push({ type: 'Date', millis }, arr);

    expect(() => ud(arr)).to.throw(TypeError, 'Duck hunt cycle');
  });
  it('array custom props', () => {
    const arr = [ 0 ];
    arr.x = false;
    const symbol = Symbol('foo');
    arr[symbol] = 'bar';

    const unducked = unduck(arr);
    expect(unducked[0]).to.equal(0);
    expect(unducked.x).to.equal(false);
    expect(unducked[symbol]).to.equal('bar');
  });
  it('multiple used array', () => {
    const inner = [ { type: 'Date', millis } ];
    const outer = [ inner, inner ];

    const reportingDateType = Object.assign({}, dateType);
    let callCount = 0;
    reportingDateType.toConstructorArguments = (...args) => {
      ++callCount;
      return dateType.toConstructorArguments(...args);
    };

    const ud = unduck.withTypes(reportingDateType);

    const unducked = ud(outer);
    expect(Array.isArray(unducked)).to.equal(true);
    expect(unducked.length).to.equal(2);
    expect(unducked[0].length).to.equal(1);
    expect(unducked[0] === unducked[1]).to.equal(true);
    expect(unducked[0][0] === unducked[1][0]).to.equal(true);
    expect(unducked[0][0] instanceof Date).to.equal(true);

    expect(callCount).to.equal(1);
  });
  it('__proto__ on obj', () => {
    const ud = unduck.withTypes(dateType);
    const proto = {};
    const pojo = { type: 'Date', millis, '__proto__': proto };
    const unducked = ud(pojo);
    expect(Object.getPrototypeOf(unducked)).to.equal(Date.prototype);
    expect(Object.hasOwnProperty.call(unducked, '__proto__')).to.equal(false);
  });
  it('symbols', () => {
    const millisSymbol = Symbol('millis');
    const dateSymbol = Symbol('Date');
    const symbolDateType = {
      classType: Date,
      properties: {
        type: {
          value: dateSymbol,
        },
        [millisSymbol]: {
          type: 'number',
        },
      },
      toConstructorArguments(props) {
        return [ props[millisSymbol] ];
      },
    };
    const ud = unduck.withTypes(symbolDateType);

    const unducked = ud({ [millisSymbol]: millis, type: dateSymbol });
    expect(unducked instanceof Date).to.equal(true);
    expect(Number(unducked)).to.equal(millis);
  });
  it('string type mismatch', () => {
    const ud = unduck.withTypes(dateType);
    const pojo = { type: 'Date', millis: '1234' };

    expect(() => ud(pojo))
      .to.throw(DuckError, 'Failed to convert property millis using type Date');
  });

  describe('ambiguous', () => {
    class Base {
      constructor({ id, x }) {
        this.id = id;
        this.x = x;
      }
    }
    class Foo extends Base {}
    class Bar extends Base {}

    const fooType = {
      classType: Foo,
      toConstructorArguments: Array,
      properties: {
        id: { type: 'number' },
        x: { type: Foo, required: false },
      },
    };
    const barType = {
      classType: Bar,
      toConstructorArguments: Array,
      properties: {
        id: { type: 'string' },
        x: { type: Object, required: false, recurse: false },
      },
    };

    const ud = unduck.withTypes(fooType, barType);
    it('a', () => {
      const unducked = ud({ id: 1234 });
      expect(unducked instanceof Foo).to.equal(true);
    });
    it('b', () => {
      const unducked = ud({ id: '1234' });
      expect(unducked instanceof Bar).to.equal(true);
    });
    it('a.x recurses', () => {
      const unducked = ud({ id: 1234, x: { id: 4567 } });
      expect(unducked.x instanceof Foo).to.equal(true);
    });
    it('b.x norecurse', () => {
      const pojo = { id: '1234', x: { id: 4567 } };
      const unducked = ud(pojo);
      expect(unducked.x instanceof Foo).to.equal(false);
      expect(unducked.x).to.equal(pojo.x);
    });
    it('a.x recurses badly', () => {
      expect(() => ud({ id: 1234, x: { id: '4567' } }))
        .to.throw(DuckError, [
          'Foo: MissingDuckError: Failed to convert property x using type Foo',
          'Bar: MissingDuckError: Failed to convert property id using type Bar',
        ].join('\n'));
    });
    it('a.x failure does not prevent b.x', () => {
      const unducked = ud({ id: '1234', x: { id: '4567' } });
      expect(unducked.x instanceof Bar).to.equal(false);
    });
    it('a.y', () => {
      expect(() => ud({ id: 1234, y: { id: 4567 } }))
        .to.throw(DuckError, [
          'Foo: MissingDuckError: Duck type Foo does not allow key y',
          'Bar: MissingDuckError: Duck type Bar does not allow key y',
        ].join('\n'));
    });
    it('b.y', () => {
      expect(() => ud({ id: '1234', y: { id: 4567 } }))
        .to.throw(DuckError, [
          'Foo: MissingDuckError: Duck type Foo does not allow key y',
          'Bar: MissingDuckError: Duck type Bar does not allow key y',
        ].join('\n'));
    });
    it('dtree', () => {
      expect(ud._diagnostic()).to.deep.equal({
        'count': 2,
        'key': 'id',
        'have': {
          'count': 2,
          // Ambiguity.  Need value type to resolve
          'duckTypes': [ 'Foo', 'Bar' ],
        },
        'haveNot': {
          'count': 0,
          'duckTypes': [],
        },
      });
    });
  });

  describe('hunt among 3', () => {
    class Thing {
      constructor({ x }) {
        this.x = x;
      }
    }

    const thingType = {
      classType: Thing,
      toConstructorArguments: Array,
      properties: {
        x: { type: 'number' },
        type: { value: 'Thing' },
      },
    };

    class Point {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    }

    const pointType = {
      classType: Point,
      toConstructorArguments({ x, y }) {
        return [ x, y ];
      },
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
      },
    };

    const ud = unduck.withTypes(dateType, thingType, pointType);
    it('date', () => {
      const unducked = ud({ type: 'Date', millis });
      expect(unducked instanceof Date).to.equal(true);
    });
    it('thing', () => {
      const unducked = ud({ type: 'Thing', x: 1 });
      expect(unducked instanceof Thing).to.equal(true);
    });
    it('point', () => {
      const unducked = ud({ x: 1, y: 2 });
      expect(unducked instanceof Point).to.equal(true);
    });
    it('unknown', () => {
      expect(() => ud({ type: 'Other', x: -1 }))
        .to.throw(DuckError, 'Could not find duck type for\n  [type]');
    });
    it('dtree', () => {
      expect(ud._diagnostic()).to.deep.equal({
        'count': 3,
        'key': 'type',
        'have': {
          'count': 0,
          'duckTypes': [],
        },
        'haveNot': {
          'count': 1,
          'duckTypes': [ 'Point' ],
        },
        'valueMap': {
          'Date': {
            'count': 2,
            'key': 'millis',
            'have': {
              'count': 1,
              'duckTypes': [ 'Date' ],
            },
            'haveNot': {
              'count': 1,
              'duckTypes': [ 'Point' ],
            },
          },
          'Thing': {
            'count': 2,
            'key': 'y',
            'have': {
              'count': 1,
              'duckTypes': [ 'Point' ],
            },
            'haveNot': {
              'count': 1,
              'duckTypes': [ 'Thing' ],
            },
          },
        },
      });
    });
  });

  it('sentinel values not unducked', () => {
    // A value used for its identity
    const sentinel = {};

    class Empty {}
    class HasSentinel {}

    const ud = unduck.withTypes(
      {
        classType: HasSentinel,
        toConstructorArguments: Array,
        properties: {
          x: { value: sentinel },
        },
      },
      {
        classType: Empty,
        toConstructorArguments: Array,
        properties: {},
      });

    expect(ud({}) instanceof Empty).to.equal(true);
    expect(ud({ x: sentinel }) instanceof HasSentinel).to.equal(true);
    expect(() => ud({ x: {} })).to.throw(DuckError);
  });

  describe('ugly duck types', () => {
    it('empty', () => {
      expect(() => unduck.withTypes({})).to.throw();
    });
    it('no classType', () => {
      expect(
        () =>
          unduck.withTypes({ properties: {}, toConstructorArguments: Array }))
        .to.throw(Error, 'missing .classType');
      expect(
        () =>
          unduck.withTypes({
            // Not a function
            classType: {},
            properties: {},
            toConstructorArguments: Array,
          }))
        .to.throw(Error, 'missing .classType');
    });
    it('no toConstructorArguments', () => {
      expect(
        () =>
          unduck.withTypes({
            classType: class C {},
            properties: {},
          }))
        .to.throw(Error, 'missing .toConstructorArguments');
      expect(
        () =>
          unduck.withTypes({
            classType: class C {},
            properties: {},
            // Not a function
            toConstructorArguments: [],
          }))
        .to.throw(Error, 'missing .toConstructorArguments');
    });
    it('no properties', () => {
      expect(
        () =>
          unduck.withTypes({
            classType: class C {},
            toConstructorArguments: Array,
          }))
        .to.throw(Error, 'missing .properties');
      expect(
        () =>
          unduck.withTypes({
            classType: class C {},
            // Not an object
            properties: false,
            toConstructorArguments: Array,
          }))
        .to.throw(Error, 'missing .properties');
      expect(
        () =>
          unduck.withTypes({
            classType: class C {},
            // Not an object
            properties: null,
            toConstructorArguments: Array,
          }))
        .to.throw(Error, 'missing .properties');
    });
    it('__proto__ tends to explode when handled', () => {
      const properties = {};
      Object.defineProperty(
        properties, '__proto__',
        { enumerable: true, configurable: true, value: {} });
      expect(Object.hasOwnProperty.call(properties, '__proto__'))
        .to.equal(true);
      expect(
        () =>
          unduck.withTypes({
            classType: class C {},
            // Not an object
            properties,
            toConstructorArguments: Array,
          }))
        .to.throw(Error, '__proto__ has a special meaning');
    });
  });
  describe('trusted properties', () => {
    let canaryAlive = true;

    // Sending an input other than this to a canary will kill it.
    const safeCanaryInputPattern = /^tweet( \d+)?$/;

    class Sensitive {
      constructor(x, trusted) {
        if (x !== null && !safeCanaryInputPattern.test(x)) {
          canaryAlive = false;
          // eslint-disable-next-line no-console
          console.trace(`(-v-)  <-  ${ x }`);
        }
        this.x = x;
        this.trusted = trusted;
      }
    }
    const classType = Sensitive;

    function toConstructorArguments({ x = null }, trusted) {
      return [ x, trusted ];
    }

    function canaryTest(name, test) {
      it(name, () => {
        canaryAlive = true;
        test();
        expect(canaryAlive).to.equal(true);
      });
    }

    function softConvert(value, trusted) {
      if (trusted) {
        return value;
      }
      const svalue = `${ value }`;
      if (safeCanaryInputPattern.test(svalue)) {
        return svalue;
      }
      return 'tweet 999';
    }

    function hardConvert(value, trusted, userContext, notApplicable) {
      if (trusted) {
        return value;
      }
      const svalue = `${ value }`;
      if (safeCanaryInputPattern.test(svalue)) {
        return svalue;
      }
      return notApplicable;
    }

    canaryTest('optional', () => {
      const ud = unduck.withTypes({
        classType,
        toConstructorArguments,
        properties: {
          x: {
            trusted: true,
            required: false,
            default: 'tweet',
          },
        },
      });
      expect(ud({ x: 'die!' }).x).to.equal('tweet');
      expect(ud({ x: 'tweet' }).x).to.equal('tweet');
      expect(ud({}).x).to.equal('tweet');
      expect(ud.trust({ x: 'tweet 123' }).x).to.equal('tweet 123');
      expect(ud.trust({}).x).to.equal('tweet');

      expect(ud({ x: 'tweet' }).trusted).to.equal(false);
      expect(ud.trust({ x: 'tweet' }).trusted).to.equal(true);
    });
    canaryTest('no fallback', () => {
      const ud = unduck.withTypes({
        classType,
        toConstructorArguments,
        properties: {
          x: {
            trusted: true,
          },
        },
      });
      expect(ud({ x: 'die!' }).x).to.equal(null);
      expect(ud({ x: 'tweet' }).x).to.equal(null);
      expect(() => ud({})).to.throw();
      expect(ud.trust({ x: 'tweet 123' }).x).to.equal('tweet 123');
    });
    canaryTest('with fallback', () => {
      const ud = unduck.withTypes({
        classType,
        toConstructorArguments,
        properties: {
          x: {
            trusted: true,
            innocuous: 'tweet',
          },
        },
      });
      expect(ud({ x: 'die!' }).x).to.equal('tweet');
      expect(ud({ x: 'tweet' }).x).to.equal('tweet');
      expect(() => ud({})).to.throw();
      expect(ud.trust({ x: 'tweet 123' }).x).to.equal('tweet 123');
    });
    canaryTest('soft required', () => {
      const ud = unduck.withTypes({
        classType,
        toConstructorArguments,
        properties: {
          x: {
            required: true,
            convert: softConvert,
          },
        },
      });
      expect(ud({ x: 'die!' }).x).to.equal('tweet 999');
      expect(ud({ x: 'tweet' }).x).to.equal('tweet');
      expect(() => ud({})).to.throw();
      expect(ud.trust({ x: 'tweet 123' }).x).to.equal('tweet 123');
      expect(() => ud.trust({})).to.throw();
    });
    canaryTest('hard required', () => {
      const ud = unduck.withTypes({
        classType,
        toConstructorArguments,
        properties: {
          x: {
            required: true,
            convert: hardConvert,
          },
        },
      });
      expect(() => ud({ x: 'die!' })).to.throw();
      expect(ud({ x: 'tweet' }).x).to.equal('tweet');
      expect(() => ud({})).to.throw();
      expect(ud.trust({ x: 'tweet 123' }).x).to.equal('tweet 123');
      expect(() => ud.trust({})).to.throw();
    });
    canaryTest('soft optional', () => {
      const ud = unduck.withTypes({
        classType,
        toConstructorArguments,
        properties: {
          x: {
            required: false,
            convert: softConvert,
          },
        },
      });
      expect(ud({ x: 'die!' }).x).to.equal('tweet 999');
      expect(ud({ x: 'tweet' }).x).to.equal('tweet');
      expect(ud({}).x).to.equal(null);
      expect(ud.trust({ x: 'tweet 123' }).x).to.equal('tweet 123');
      expect(ud.trust({}).x).to.equal(null);
    });
    canaryTest('hard optional', () => {
      const ud = unduck.withTypes({
        classType,
        toConstructorArguments,
        properties: {
          x: {
            required: false,
            convert: hardConvert,
          },
        },
      });

      expect(() => ud({ x: 'die!' })).to.throw();
      expect(ud({ x: 'tweet' }).x).to.equal('tweet');
      expect(ud({}).x).to.equal(null);
      expect(ud.trust({ x: 'tweet 123' }).x).to.equal('tweet 123');
      expect(ud.trust({}).x).to.equal(null);
    });
  });
  it('converter order', () => {
    const ud = unduck.withTypes({
      classType: class Foo {
        constructor({ x }) {
          this.x = x;
        }
      },
      toConstructorArguments: Array,
      properties: {
        x: {
          type: 'number',
          // Implicitly coerces to number but after using ambiguous binary op
          convert: (x) => Number(x + 1),
        },
      },
    });
    // Not 11 by concatenation
    expect(ud({ x: 1 }).x).to.equal(2);
    expect(() => ud({ x: '1' })).to.throw();
  });
  describe('userContext', () => {
    const reachedWithoutFunction = [];

    const ud = unduck.withTypes({
      classType: function classType(x) {
        return { '_x': x };
      },
      toConstructorArguments(properties, trusted, userContext) {
        if (typeof userContext === 'function') {
          userContext('toConstructorArguments', properties);
        } else {
          reachedWithoutFunction.push(userContext);
        }
        return [ properties.x ];
      },
      properties: {
        x: {
          convert(value, trusted, userContext) {
            if (typeof userContext === 'function') {
              userContext('convert', value);
            } else {
              reachedWithoutFunction.push(userContext);
            }
            return value;
          },
          required: false,
        },
      },
    });

    function makeLogger() {
      const items = [];
      function log(...args) {
        items.push(args);
      }
      log.items = items;
      return log;
    }

    function postCond() {
      expect(reachedWithoutFunction.length, reachedWithoutFunction).to.equal(0);
    }

    it('reaches converter', () => {
      const log = makeLogger();
      ud({}, log);
      expect(log.items).to.deep.equals(
        [ [ 'toConstructorArguments', {} ] ]);
      postCond();
    });
    it('reaches toConstructor', () => {
      const log = makeLogger();
      ud({ x: 'x' }, log);
      expect(log.items).to.deep.equals(
        [ [ 'convert', 'x' ], [ 'toConstructorArguments', { x: 'x' } ] ]);
      postCond();
    });
    it('reaches nested', () => {
      const log = makeLogger();
      const result = ud({ x: { x: 'x' } }, log);
      expect(log.items).to.deep.equals(
        [
          [ 'convert', 'x' ],
          [ 'toConstructorArguments', { 'x': 'x' } ],
          [ 'convert', { _x: 'x' } ],
          [ 'toConstructorArguments', { 'x': { '_x': 'x' } } ],
        ]);
      expect(result).to.deep.equals({ '_x': { '_x': 'x' } });
      postCond();
    });
  });
});
