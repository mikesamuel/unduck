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
/* eslint no-magic-numbers: [0] */

'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const vm = require('vm');
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
    const proto = Object.create(null);
    const pojo = { type: 'Date', millis, '__proto__': proto };
    const unducked = ud(pojo);
    expect(Object.getPrototypeOf(unducked)).to.equal(Date.prototype);
    expect(Object.hasOwnProperty.call(unducked, '__proto__')).to.equal(false);
  });
  it('array and object cross realm', () => {
    const ud = unduck.withTypes(dateType);
    const pojoCrossRealm =
      new vm.Script(`([{ type: 'Date', millis: ${ millis } }])`)
        .runInNewContext();
    // Check that it really is cross realm.
    expect(Array.isArray(pojoCrossRealm)).to.equal(true);
    expect(pojoCrossRealm instanceof Array).to.equal(false);
    // Check that we processed and got a this-realm Date.
    const result = ud(pojoCrossRealm);
    expect(result instanceof Array).to.equal(true);
    expect(result[0] instanceof Date).to.equal(true);
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
  it('unexpected symbol', () => {
    const ud = unduck.withTypes(dateType);
    const symbol = Symbol('s');
    const pojo = { type: 'Date', millis: 1234, [symbol]: true };
    expect(() => ud(pojo)).to.throw(DuckError, 'Duck type Date does not allow key Symbol(s)');
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
          'Date': { 'count': 1, 'duckTypes': [ 'Date' ] },
          'Thing': { 'count': 1, 'duckTypes': [ 'Thing' ] },
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

  describe('sparse heterogeneous', () => {
    class NaryOperator {
      constructor(operator, operands) {
        this.operator = operator;
        this.operands = operands;
      }

      toString() {
        return `(${ this.operands.join(` ${ this.operator } `) })`;
      }
    }
    class UnaryOperator {
      constructor(operator, operand) {
        this.operator = operator;
        this.operand = operand;
      }

      toString() {
        return `(${ this.operator }${ this.operand })`;
      }
    }
    class CmpOperator extends NaryOperator {}
    class ArithOperator extends NaryOperator {}
    class StrOperator extends NaryOperator {}

    function toConstructorArguments(obj) {
      let operator = null;
      let operands = null;
      for (const key in obj) {
        if (operator !== null) {
          return null;
        }
        operator = key;
        operands = obj[key];
      }
      if (operator === null) {
        return null;
      }
      return [ operator, operands ];
    }

    const ud = unduck.withTypes(
      {
        classType: CmpOperator,
        toConstructorArguments,
        properties: {
          $lt: { required: false, type: Array },
          $lte: { required: false, type: Array },
          $gt: { required: false, type: Array },
          $gte: { required: false, type: Array },
          $eq: { required: false, type: Array },
          $ne: { required: false, type: Array },
        },
      },
      {
        classType: UnaryOperator,
        toConstructorArguments,
        properties: {
          $neg: { required: false },
          $not: { required: false },
          $inv: { required: false },
        },
      },
      {
        classType: ArithOperator,
        toConstructorArguments,
        properties: {
          $add: { required: false, type: Array },
          $sub: { required: false, type: Array },
          $mul: { required: false, type: Array },
          $div: { required: false, type: Array },
          $mod: { required: false, type: Array },
        },
      },
      {
        classType: StrOperator,
        toConstructorArguments,
        properties: {
          $cat: { required: false, type: Array },
          $rep: { required: false, type: Array },
          $sub: { required: false, type: Array },
          $low: { required: false, type: Array },
          $upp: { required: false, type: Array },
        },
      },
    );

    it('dtree', () => {
      expect(ud._diagnostic()).to.deep.equal({
        'count': 4,
        'haveNone': {
          'count': 4,
          'duckTypes': [
            'CmpOperator',
            'UnaryOperator',
            'ArithOperator',
            'StrOperator',
          ],
        },
        'mayHaveMap': {
          '$add': { 'count': 1, 'duckTypes': [ 'ArithOperator' ] },
          '$cat': { 'count': 1, 'duckTypes': [ 'StrOperator' ] },
          '$div': { 'count': 1, 'duckTypes': [ 'ArithOperator' ] },
          '$eq': { 'count': 1, 'duckTypes': [ 'CmpOperator' ] },
          '$gt': { 'count': 1, 'duckTypes': [ 'CmpOperator' ] },
          '$gte': { 'count': 1, 'duckTypes': [ 'CmpOperator' ] },
          '$inv': { 'count': 1, 'duckTypes': [ 'UnaryOperator' ] },
          '$low': { 'count': 1, 'duckTypes': [ 'StrOperator' ] },
          '$lt': { 'count': 1, 'duckTypes': [ 'CmpOperator' ] },
          '$lte': { 'count': 1, 'duckTypes': [ 'CmpOperator' ] },
          '$mod': { 'count': 1, 'duckTypes': [ 'ArithOperator' ] },
          '$mul': { 'count': 1, 'duckTypes': [ 'ArithOperator' ] },
          '$ne': { 'count': 1, 'duckTypes': [ 'CmpOperator' ] },
          '$neg': { 'count': 1, 'duckTypes': [ 'UnaryOperator' ] },
          '$not': { 'count': 1, 'duckTypes': [ 'UnaryOperator' ] },
          '$rep': { 'count': 1, 'duckTypes': [ 'StrOperator' ] },
          '$sub': {
            'count': 2,
            'duckTypes': [
              'ArithOperator',
              'StrOperator',
            ],
          },
          '$upp': { 'count': 1, 'duckTypes': [ 'StrOperator' ] },
        },
      });
    });
    it('expr', () => {
      const unducked = ud({
        $neg: {
          $add: [
            { $mul: [ 23, 42 ] },
            123,
          ],
        },
      });
      expect(unducked.toString()).equals('($neg((23 $mul 42) $add 123))');
    });
    it('multiple', () => {
      expect(() => ud({ $neg: 1, $inv: 2 })).to.throw(
        DuckError, 'Failed to compute constructor arguments for UnaryOperator');
    });
    it('empty', () => {
      expect(() => ud({})).to.throw(
        DuckError, [
          'CmpOperator: MissingDuckError: Failed to compute constructor arguments for CmpOperator',
          'UnaryOperator: MissingDuckError: Failed to compute constructor arguments for UnaryOperator',
          'ArithOperator: MissingDuckError: Failed to compute constructor arguments for ArithOperator',
          'StrOperator: MissingDuckError: Failed to compute constructor arguments for StrOperator',
        ].join('\n'));
    });
  });
  describe('mixed content', () => {
    class ContentChunk {
      constructor(text) {
        this.text = text;
      }

      toString() {
        return `(${ this.constructor.name } ${ JSON.stringify(this.text) })`;
      }

      // eslint-disable-next-line class-methods-use-this, no-unused-vars
      update(container) {
        throw new Error('implement me');
      }
    }

    class PlainText extends ContentChunk {
      update(container) {
        container.textContent = this.text;
      }
    }

    class Html extends ContentChunk {
      update(container) {
        // Danger
        container.innerHTML = this.text;
      }
    }

    class Comments {
      constructor(comments) {
        this.comments = [ ...comments ];
      }

      toString() {
        return this.comments.join('\n');
      }
    }

    const ud = unduck.withTypes(
      {
        classType: Comments,
        toConstructorArguments({ comments }) {
          return [ comments ];
        },
        properties: {
          comments: { type: Array },
        },
      },
      {
        classType: PlainText,
        toConstructorArguments({ text }) {
          return [ text ];
        },
        properties: {
          type: { value: 'text/plain', required: false },
          text: { type: 'string' },
        },
      },
      {
        classType: Html,
        toConstructorArguments({ text }) {
          return [ text ];
        },
        properties: {
          type: { value: 'text/html' },
          text: {
            type: 'string',
            innocuous: 'Elided',
            // By Html.update above
            trusted: true,
          },
        },
      },
    );

    const comment0 = { text: 'Be <b>nice</b>, Management!', type: 'text/html' };
    const comment1 = { text: 'Hello' };
    const comment2 = { text: 'World!', type: 'text/plain' };

    const attackerControlledString =
      '{ "text": "<script>alert(1)</script>", "type": "text/html" }';

    const expected = [
      '(Html "Be <b>nice</b>, Management!")',
      '(PlainText "Hello")',
      '(PlainText "World!")',
      '(Html "Elided")',
    ].join('\n');

    it('dtree', () => {
      expect(ud._diagnostic()).to.deep.equal({
        'count': 3,
        'key': 'type',
        'have': { 'count': 0, 'duckTypes': [] },
        'haveNot': {
          'count': 2,
          'key': 'comments',
          'have': { 'count': 1, 'duckTypes': [ 'Comments' ] },
          'haveNot': { 'count': 1, 'duckTypes': [ 'PlainText' ] },
        },
        'valueMap': {
          'text/html': { 'count': 1, 'duckTypes': [ 'Html' ] },
          'text/plain': { 'count': 1, 'duckTypes': [ 'PlainText' ] },
        },
      });
    });
    it('trust nested within untrust', () => {
      const unducked = ud({
        comments: [
          ud.trust(comment0), comment1, comment2,
          JSON.parse(attackerControlledString),
        ],
      });
      expect(unducked.toString()).to.equal(expected);
    });
    it('untrust nested within trust', () => {
      const unducked = ud.trust({
        comments: [
          comment0, comment1, comment2,
          ud(JSON.parse(attackerControlledString)),
        ],
      });
      expect(unducked.toString()).to.equal(expected);
    });
    it('nest explicit class value', () => {
      const unducked = ud({
        comments: [
          new Html(comment0.text), comment1, comment2,
          JSON.parse(attackerControlledString),
        ],
      });
      expect(unducked.toString()).to.equal(expected);
    });
  });
  describe('special value ambiguity', () => {
    class LabeledObject {
      constructor(label, x) {
        this.label = label;
        this.x = x;
      }
    }

    function makeToConstructorArguments(label) {
      return function toConstructorArguments(x) {
        return [ label, x ];
      };
    }

    // Define a highly specific value switch and then make sure
    // that that property still works in a type that does not
    // require any specific value.
    const ud = unduck.withTypes(
      {
        classType: class TypeA extends LabeledObject {},
        toConstructorArguments: makeToConstructorArguments('A'),
        properties: {
          x: { value: 'a' },
        },
      },
      {
        classType: class TypeB extends LabeledObject {},
        toConstructorArguments: makeToConstructorArguments('B'),
        properties: {
          x: { value: 'b' },
        },
      },
      {
        classType: class TypeC extends LabeledObject {},
        toConstructorArguments: makeToConstructorArguments('C'),
        properties: {
          x: { value: 'c' },
        },
      },
      {
        classType: class TypeD extends LabeledObject {},
        toConstructorArguments: makeToConstructorArguments('D'),
        properties: {
          x: { value: 'd' },
        },
      },
      {
        classType: class TypeE extends LabeledObject {},
        toConstructorArguments: makeToConstructorArguments('E'),
        properties: {
          x: { default: 'e' },
          y: { },
        },
      },
    );

    it('dtree', () => {
      function just(name) {
        return { count: 1, duckTypes: [ name ] };
      }
      expect(ud._diagnostic()).to.deep.equal({
        count: 5,
        key: 'x',
        valueMap: {
          'a': { count: 2, key: 'y', have: just('TypeE'), haveNot: just('TypeA') },
          'b': { count: 2, key: 'y', have: just('TypeE'), haveNot: just('TypeB') },
          'c': { count: 2, key: 'y', have: just('TypeE'), haveNot: just('TypeC') },
          'd': { count: 2, key: 'y', have: just('TypeE'), haveNot: just('TypeD') },
        },
        have: just('TypeE'),
        haveNot: just('TypeE'),
      });
    });
    it('a-d no y', () => {
      expect(ud({ x: 'a' }).label).to.equal('A');
      expect(ud({ x: 'b' }).label).to.equal('B');
      expect(ud({ x: 'c' }).label).to.equal('C');
      expect(ud({ x: 'd' }).label).to.equal('D');
    });
    it('a-d with y', () => {
      expect(ud({ x: 'a', y: 0 }).label).to.equal('E');
      expect(ud({ x: 'b', y: 0 }).label).to.equal('E');
      expect(ud({ x: 'c', y: 0 }).label).to.equal('E');
      expect(ud({ x: 'd', y: 0 }).label).to.equal('E');
    });
    it('not a-d', () => {
      expect(ud({ x: 'e', y: 0 }).label).to.equal('E');
      expect(ud({ x: 'f', y: 0 }).label).to.equal('E');
      expect(ud({ y: 0 }).label).to.equal('E');
    });
  });
});
