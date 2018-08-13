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

'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const { unduck, ud, DuckError } = require('../index.js');

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

  it('alias', () => {
    expect(unduck).to.equal(ud);
  });
  it('scoping', () => {
    const _ud = ud.withTypes(dateType);

    const pojo = { type: 'Date', millis };

    const date = _ud(pojo);
    expect(date instanceof Date).to.equal(true);
    expect(Number(date)).to.equal(millis);

    expect(() => ud(pojo)).to.throw(DuckError);

    // date and pojo are reference distinct
    expect(date.type).to.equal(undefined);
    expect(pojo.type).to.equal('Date');
  });
  it('not a date', () => {
    const _ud = ud.withTypes(dateType);
    expect(() => _ud({ type: 'late', millis })).to.throw(DuckError);
  });
  it('extra junk', () => {
    const _ud = ud.withTypes(dateType);
    expect(() => _ud({ type: 'Date', millis, foo: 'bar' })).to.throw(DuckError);
  });
  it('primitive array', () => {
    // eslint-disable-next-line no-magic-numbers
    const arr = [ 0, 1, 2, 3, 'four', null, [ 6 ] ];
    const unducked = ud(arr);

    expect(arr === unducked).to.equal(false);
    expect(arr).to.deep.equal(unducked);
  });
  it('array cycle detected', () => {
    const _ud = ud.withTypes(dateType);
    const arr = [];
    arr.push({ type: 'Date', millis }, arr);

    expect(() => _ud(arr)).to.throw(TypeError);
  });
  it('array custom props', () => {
    const arr = [ 0 ];
    arr.x = false;
    const symbol = Symbol('foo');
    arr[symbol] = 'bar';

    const unducked = ud(arr);
    expect(unducked[0]).to.equal(0);
    expect(unducked.x).to.equal(false);
    expect(unducked[symbol]).to.equal('bar');
  });
  it('multiple used array', () => {
    const inner = [ { type: 'Date', millis } ];
    const outer = [ inner, inner ];

    const reportingDateType = Object.assign({}, dateType);
    let callCount = 0;
    reportingDateType.toConstructorArguments = function (...args) {
      ++callCount;
      return dateType.toConstructorArguments(...args);
    };

    const _ud = ud.withTypes(reportingDateType);

    const unducked = _ud(outer);
    expect(Array.isArray(unducked)).to.equal(true);
    expect(unducked.length).to.equal(2);
    expect(unducked[0].length).to.equal(1);
    expect(unducked[0] === unducked[1]).to.equal(true);
    expect(unducked[0][0] === unducked[1][0]).to.equal(true);
    expect(unducked[0][0] instanceof Date).to.equal(true);

    expect(callCount).to.equal(1);
  });
  it('__proto__ on obj', () => {
    const _ud = ud.withTypes(dateType);
    const proto = {};
    const pojo = { type: 'Date', millis, '__proto__': proto };
    const unducked = _ud(pojo);
    expect(Object.getPrototypeOf(unducked)).to.equal(Date.prototype);
    expect(unducked.hasOwnProperty('__proto__')).to.equal(false);
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
    const _ud = ud.withTypes(symbolDateType);

    const unducked = _ud({ [millisSymbol]: millis, type: dateSymbol });
    expect(unducked instanceof Date).to.equal(true);
    expect(Number(unducked)).to.equal(millis);
  });
  it('string type mismatch', () => {
    const _ud = ud.withTypes(dateType);
    const pojo = { type: 'Date', millis: '1234' };

    expect(() => _ud(pojo)).to.throw(DuckError);
  });
});
