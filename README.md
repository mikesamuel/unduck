# How to build castles out of ducks

by easily upgrading bags of properties to instances of classes.

## Problem: Ducks can be hard to juggle

JavaScript provides two main ways to represent structured data.

```js
// Named Types
class Point {
  constructor({ x, y }) {
    this.x = x;
    this.y = y;
  }
}
let myInstance = new Point({ x: 1, y: 2 });


// Bags of Properties
let myBag = { x: 1, y: 2 };
```

It is more convenient to *use* an instance of a well-defined class,
but it is easier to *create* a bag of properties.

Some frameworks define APIs in terms of bags of properties:
*  [MongoDB's query language][mongo-query]: `db.foo.findAndModify({query: {_id: 123, available: {$gt: 0}}})`
*  [Babel AST builders][babel-builders] produce values like `{ type: 'BinaryExpression', operator: '+', ... }`
*  [sanitize-html][] takes policy objects like `{ allowedTags: [ 'b', 'i' ], ... }`
*  [hapi][] uses routing rules like `{ method: 'GET', path: '/', config: ... }`
*  Many APIs document configuration and option bundles in JavaScript object syntax.

Classes provide a natural place to check invariants, and work with
`instanceof` to provide easy *is-a* checks.

Bags of properties are hard to check early, and [JSON object forgery][]
attacks exploit the fact that libraries can't rely on user code to
endorse the bag as being appropriate to use in a particular way.

> JSON.parse makes it easy to unintentionally turn untrustworthy
> strings into untrustworthy objects which has led to problems when
> key pieces of infrastructure are less suspicious of objects than of
> strings.
>
> ...
>
> duck typing is a terrible basis for authorization decisions

This proposal seeks to bridge bags of properties with class
types so that it is convenient to create instances of well-defined
classes making it more transparent to consumers of the object how
to use them safely.

### What is obvious to a developer is not to the JS engine.

A developer might see

```js
let myMessage = {
  body: 'Hello, World!',
  timestamp: Date.now(),
  recipient: ['j.friendly@example.com']
};

let expiry = {
  type: 'Instant',
  timestamp: Date.now()
};

let attachment = {
  body: 'SSA8MyBkdWNrcyE=',
  encoding: 'base64',
  type: 'text/plain',
  modified: {
    type: 'Instant',
    timestamp: 1533912060207
  }
};
```

and mentally map those to three different concepts: an email message,
an instant in time, and some kind of file.

Additionally, the developer might deduce that the `body` fields of
messages and attachments might be attacker-controlled elsewhere,
and that the `type: 'Instant'` is boilerplate.

The JavaScript engine can't.

More problematically, the difference between which fields are attacker
controlled is apparent in the code here, but not to downstream code
that merges, combines, or uses properties.

### Duck typing

Hereafter, "duck type" refers to these informal types.  Note: this is a
narrower definition than readers may be familiar with: a type
defined based on the properties and methods it provides insetad of
the constructor used to create values or prototypes.

TypeScript lets us bring duck types into the type system with [index
types][] and [literal types][].

```ts
interface Message {
  body: String,  // Unfiltered HTML
  timestamp?: Number,  // ? means Optional
  recipient: AddressSpec
}

interface Instant {
  type: 'Instant',  // Literal type
  timestamp: Number
}

interface TypedContent {
  body: String,
  encoding: Encoding,
  type: MimeType,
  modified?: Instant
}
```

Given a description like this, TypeScript can look at
`let x: T = { key: value }` expression and decide whether
`{ key: value }` is really a `T`.

Switching to typescript is not easy though, nor is adding
the right `: T` to every creation of an *Object* via `{ ... }`.

The rest of this document explains how an operator, tentatively
called *unduck*, might:

*  Collect type descriptions like the `interface`s above,
*  Pick an appropriate class type given a bag of properties,
*  Assemble arguments to the class's constructor from the bag of properties,
*  Distinguish between bags from an external source
   and bags created by trusted user code,
*  Respect scopes by not assuming that all modules are interested in
   constructing all duckable types.

## Design sketch

We need a way to refer to duck typing so we can declare types, and
convert between bags of properties and `class` type instances.

Below we will use &#x1F425; as a shorthand for *from duck* or
*deduck*.  (&#x1F425; is actually ["front-Facing Baby Chick"][chick]
but the author thinks it looks like a duckling and, more importantly,
is more adorable than &#x1F986;.)

(The author knows that &#x1F425; is not a valid JavaScript
*IdentifierName*.  &#x1F425; is a placeholder for bike-shedding to
happen at a later date and stands out nicely in code samples.)

```js
let 🐥 = global.🐥;
🐥 = 🐥.withTypes({
  classType: class Point2D {
    constructor(x, y) {
      this.x = +x;
      this.y = +y;
      if (isNaN(this.x) || isNaN(this.y)) {
        throw new TypeError('Invalid numeric input');
      }
    }
  },
  properties: {
    'x': {
      type: Number,
      required: true  // the default
    },
    'y': {
      type: Number
    },
    'type': {
      value: 'Point2D'
    }
  },
  toConstructorArguments({ x, y }) { return [ x, y ] }
});
```

Duck property descriptors can also specify:
*  Whether to recursively unduck the property value if it is an object.
   Defaults to true.
*  A custom value converter which takes `(value, notApplicable)` and
   returns `notApplicable` to indicate that the type is not applicable.
   See the duck hunt algorithm below.
*  Whether the value is *innocuous*.  See danger duck below.

Babel internally uses [type definitions][babel-defn] that contain
similar information.

### Duck ponds

A *duck pond* is a set of type relationships.

The code above creates a local variable, &#x1F425;, by deriving from a
global &#x1F425;, and registers a type relationship with it.

By assigned to &#x1F425; in a module scope, the developer can add type
relationships which will affect calls to &#x1F425;(...) in that
module.

### The duck hunt algorithm

The important thing about a duck pond is that we can derive from it
a decision tree to relate a bag of properties to a class instance,
and derive arguments to that class's constructor.

The duck hunt algorithm takes a bag of properties and a pond, then:

1.  Applies a decision tree to narrow the set of applicable type relationships
    to the maximal subset of the pond such that the bag of properties
    *  has all required properties,
    *  has no property that is neither required nor optional,
    *  has no property whose value does not match a required value
       (See `value` in the property descriptor above),
    *  has no property whose value that does not pass a corresponding
       type guard.
1.  Call `toConstructorArguments` for each applicable type relationship.
1.  Await all the results from `toConstructorArguments`.
    For each, if the result is not an array, then remove the type relationship
    from the applicable set.
1.  Fail if there is not exactly one applicable type relationship.
1.  Return the result of applying the applicable type relationship's
    `classType`'s constructor to the sole `toConstructorArguments` result.



### How to make ducks?

To turn a nested bag of properties into a value, simply initialize
your duck pond as above, and then call the autoduck operator.

```js
import * as ShapesLibrary from 'ShapesLibrary';

// Maybe libraries provide a way to register their duckable types.
let 🐥 = ShapesLibrary.fillPond(global.🐥);

let myTriangle = 🐥({
  path: {
    points: [
      {
        start: { x: 50, y: 25 },
        end: { x: 25, y: 50 },
      },
      { ... },
      { ... }
    ]
  }
});
```

Compare that to a use of explicit type names:

```js
import { Shape, Path, LineSegment, Point } from 'ShapesLibrary';

let myTriangle = new Shape(
  new Path(
    new LineSegment(
        new Point(50, 25),
        new Point(25, 50)),
    new LineSegment(...),
    new LineSegment(...)));
```

## To duck or not to duck

Having written lots of Java and C++, the author does not find the
latter code sample hard to read, and doesn't find the `import` and
setup code onerous.

But novice programmers do seem to find bags-of-properties style APIs
easy to learn and use.

Being able to produce well-governed object graphs like the latter
gives API authors more choices.

If a project's developers are comfortable reasoning about type
hierarchies and how they compose, then there's no need for duck types.

If you have to choose between bags of properties and auto-ducking,
getting developers in the habit of using &#x1F425; gives a small
number of type maintainers the ability to see that type invariants
checks happen early and that downstream code can use `instanceof` to
check their inputs, especially those values that imply that a property
is safe to use in a sensitive context.

### Danger duck

Application code shouldn't naively convert any bag of properties to an
object.  "[JSON object forgery][]" (mentioned previously) explains why not.

> JSON.parse makes it easy to unintentionally turn untrustworthy
> strings into untrustworthy objects.

If a duck property descriptor includes a
`toSafeValue(value, notApplicable)` method, then that can convert
values from outside a [trust boundary][] to ones suitable to use
inside a trust boundary.  This could apply sanitizers, restrict to
plain strings instead of recursing, or not upgrade to a [contract type][]:

There are two patterns that might provide an easily auditable

&#x1F425;.&#x2622; (read danger duck) could indicate that an input is dangerous.  Alternatively,
&#x1F425;.&#x262e; (read peace duck) could indicate that the author trusts the input.

The latter makes the easiest to type default to safe which is preferable.
Either, if named consistently, make it easy to enumerate calls that might need auditing.

```js
[
  🐥({ foo: 'bar' }),
  🐥.☢(JSON.parse(untrustedString))
]

// or

[
  🐥.☮({ foo: 'bar' }),
  🐥(JSON.parse(untrustedString))
]
```

### Duck Migration

Given a codebase that uses bags of properties extensively, I might expect migration
to happen piecemeal:

1.  Developers pick an API that takes bags of properties.
1.  Configure it to require class types as inputs, or to report when they're not.
1.  Put &#x1F425;(...) around object constructors, run tests, tweak, and repeat until tests run green.
1.  Repeat with another API that ducks.

As noted before, without rewriting code to call the appropriate
`new ClassName`, maintainers and security auditors get the benefits of:

*  constructors that check type invariants at `new` time,
*  having a place to put code that coerces untrusted structured inputs to trustworthy structured values.


[JSON object forgery]: https://medium.com/@mikesamuel/protecting-against-object-forgery-2d0fd930a7a9
[index types]: https://www.typescriptlang.org/docs/handbook/advanced-types.html#index-types
[literal types]: https://www.typescriptlang.org/docs/handbook/advanced-types.html#string-literal-types
[mongo-query]: https://gist.github.com/raineorshine/4649304#file-mongo-cheat-sheet-js-L24
[babel-defn]: https://github.com/jamiebuilds/babel-handbook/blob/master/translations/en/plugin-handbook.md#definitions
[babel-builders]: https://github.com/jamiebuilds/babel-handbook/blob/master/translations/en/plugin-handbook.md#builders
[chick]: https://unicode.org/emoji/charts/full-emoji-list.html#1f425
[contract type]: https://github.com/WICG/trusted-types#the-problem
[trust boundary]: https://en.wikipedia.org/wiki/Trust_boundary
[sanitize-html]: https://www.npmjs.com/package/sanitize-html
[hapi]: https://hapijs.com/
