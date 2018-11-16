# API  <span name="api"></span>

Unduck is available via ([![npm](https://img.shields.io/npm/v/unduck.svg)](https://www.npmjs.com/package/unduck)).

<!-- TOC derived by running scripts/toc.pl over this file -->

*  [Defining Duck Types by Example](#def)
*  [Duck type description fields](#dt-duck-type-descriptor-fields)
    *  [`.classType(...)`](#dt-class-type)
    *  [`.toConstructorArguments(...)`](#dt-to-ctor-args)
    *  [`.properties`](#dt-properties)
        *  [`required`](#prop-required)
        *  [`type`](#prop-type)
        *  [`value`](#prop-value)
        *  [`default`](#prop-default)
        *  [`recurse`](#prop-recurse)
        *  [`trusted`](#prop-trusted)
        *  [`innocuous`](#prop-innocuous)
        *  [`convert(...)`](#prop-convert)
*  [The `unduck` function](#unduck-fn)
    *  [`.withTypes(...typeDescriptors)`](#unduck-with)
    *  [`.trust(...)`](#unduck-trust)

```js
const unduck = require(('unduck');
```

## Defining Duck Types by Example <span name="def"></span>

```js
const ud = unduck.withTypes(
  { /* first type description */ },
  { /* secondtype description */ },
);
```

creates a duck pond with two duck types.  You can then call

```js
const instanceOfFirstType = ud({ /* properties described by first type */ });
const instanceOfSecondType = ud({ /* properties described by second type */ });
```

First, a complete usage example:

```js
const unduck = require('unduck');

// Defining a class.
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

// Defining a duck type.
const ud = unbock.withType({
  // Specifies which constructor ud will use.
  classType: Point,
  // Creates a constructor argument list given properties.
  toConstructorArguments({ x, y }) { return [x, y]; },
  // The properties that can appear on a bag of properties that specifies a
  // point along with property metadata.
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
  }
};

// These two declarations create equivalent points.
const point1 = ud({ x: 7, y: -2 });
const point2 = new Point(7, -2);
```

## Duck type description fields   <span name="dt-duck-type-descriptor-fields"></span>

unduck only recognizes *own* properties in type and property descriptors.

### `.classType(...constructorArguments)`   <span name="dt-class-type"></span>

*Required* *Function*

**Arguments**

`classType` must be a function usable with `new`.
`...constructorArguments` are the output of `.toConstructorArguments`.

**Returns** any value.

### `.toConstructorArguments(properties, trusted, userContext)`  <span name="dt-to-ctor-args"></span>

*Required* *Function*

Called to convert processed properties to arguments for `.classType`.

**Arguments**

*  `properties` : *Object* -- The processed properties.
*  `trusted` : *boolean* -- True iff invoked as a result of `ud.trusted` with
   a bag of properties from a trusted source.
*  `userContext` : *any* -- If the original `ud` call had two arguments,
   this is the second argument.  Otherwise it is `undefined`.  This allows
   passing some (possibly mutable) context to every custom function for a
   particular top-level `unduck` call.

**Returns** an *Array* to indicate that *properties* are suitable, or any
other value to veto and try any another applicable duck type.
(Future versions may assume a promise is a promise for an array.)

This function may be called speculatively for nested duck type values
if there are multiple applicable duck types.  It should not throw an
exception, and instead return *null* to failover to alternatives.

### `.properties`  <span name="dt-properties"></span>

Maps keys to property descriptor like

```js
({
  x: { /* descriptor for property x */ },
  y: { /* descriptor for property y */ },
});
```

Symbol keys are ok.  The key `__proto__` is not allowed since it has a
special meaning in JavaScript.

A property descriptor may have the following fields.

#### `required`   <span name="prop-required"></span>

*boolean* -- `required; false` means that the property need not appear
in the bag for the type to be applicable.  By default, properties
are required, unless the property descriptor has a `default`
property.

#### `type`   <span name="prop-type"></span>

*string* or *Function* -- If the value is a string, it must be one
of the outputs of the `typeof` operator.  If a function, it should be a value
that makes sense to the right of `instanceof`.

#### `value`   <span name="prop-value"></span>
*any* -- If present specifies the only acceptable value.
This enables specifying types that are applicable based on boilerplate values.

Values compare using `===` (modulo NaN).

A property may be both optional and have a required value.  For example
`{ properties: { version: { value: '1.0', required: false } } }`
which means that the type is only applicable if there is no version or
if it is exactly `'1.0'`.

#### `default`   <span name="prop-default"></span>
*any* -- The value assumed if the property is not present in the input.

#### `recurse`   <span name="prop-recurse"></span>
*boolean* -- By default, property values are recursively unducked.
`recurse: false` prevents recursive unducking.

Note: unduck may call user functions like `toConstructorArguments`
and `convert` speculatively.  This may happen if there are multiple
applicable types which differ on whether unduck should recursively
process a property's value.

#### `trusted`   <span name="prop-trusted"></span>
*boolean* -- Should be true if downstream code might trust the value,
so it is important that untrusted properties not control it. Defaults to false.

Calling `ud.trust(x)` instead of `ud(x)` indicates that the caller trusts `x`.

#### `innocuous`   <span name="prop-innocuous"></span>
*any* -- A value to use if the input is not clearly trustworthy,
but downstream code might trust the parts.
Not used unless `trusted: true`.

#### `convert(value, trusted, userContext, notApplicable)`    <span name="prop-convert"></span>

*Function* -- called to convert a value for the current property to a
value for the bag passed to `toConstructorArguments`.

**Arguments**

*  `value` : *any* -- The raw property value to convert.
*  `trusted` : *boolean* -- Whether the top level call asserts *value*'s
   trustworthiness.  See `trusted` and `innocuous` below.
   The top level unduck call specifies this argument.  It is independent
   of the `trusted` property descriptor field, so `convert` can pick
   their own safe value instead of relying on a single `innocuous` value.
*  `userContext` : *any* -- If the original `ud` call had two arguments,
   this is the second argument.  Otherwise it is `undefined`.  This allows
   passing some (possibly mutable) context to every custom function for a
   particular top-level `ud` call.
*  `notApplicable` : *Object* -- a sentinel value that `convert` may return
   to indicate that the duck type is not applicable to the input.

**Return**

The processed value for the property, or `notApplicable` to abort further
processing using the current duck type.

`convert` calls happen after substituting `default` or `innocuous` values as
appropriate, after the value is recursively unducked if appropriate,
and after and only after the value passes any `type` check.

## The `unduck` function  <span name="unduck-fn"></span>

### `.withTypes(...typeDescriptors)`  <span name="unduck-with"></span>

`const unduck = require('unduck')` brings an unduck function into scope
that has zero duck types.

`myUnduck.withTypes(additionalType)` produces a new unduck function
that inherits the duck types from `myUnduck` and also recognizes the
type descriptor `additionalType`.

```js
const unduck = require('unduck');

// Calls can happen separately as long as you use the return value.
let ud = unduck.withTypes(typeDescriptor1);
ud = ud.withTypes(typeDescriptor2);

// Can pass ud out to library code.
ud = myFavoriteLibrary.registerSomeTypes(ud);

((ud) => {
  // A narrower scope.
  ud = ud.withTypes(typeDescriptorVisibleInNarrowScope);

  ...
})(ud);

```

### `.trust(input)`  <span name="unduck-trust"></span>

Application code shouldn't naively convert any bag of properties to an
object.  "[JSON object forgery][]" explains why not.

> JSON.parse makes it easy to unintentionally turn untrustworthy
> strings into untrustworthy objects.

By default, unduck replaces [trusted](#prop-trusted) property values with
[innocuous](#prop-innocuous) values, and by default the `trusted` parameter
to convert functions and to `toConstructorArguments` is false.

This avoids problems when all or part of the bag of properties comes from
an untrusted source like `ud(JSON.parse(untrustedString)`.

When you know that the input is trustworthy, use `ud.trust(input)`.

Prefer using `convert` functions that sanitize inputs to explicitly
trusting inputs.


[JSON object forgery]: https://medium.com/@mikesamuel/protecting-against-object-forgery-2d0fd930a7a9

