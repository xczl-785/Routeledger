const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const formatPath = (path) => path.reduce((formattedPath, segment) => {
    if (typeof segment === "number")
        return `${formattedPath}[${segment}]`;
    return `${formattedPath}.${segment}`;
}, "$");
const describeExpectedType = (schema) => typeof schema.type === "string" ? schema.type : "valid value";
const hasEnumMatch = (allowedValues, value) => allowedValues.some((allowedValue) => Object.is(allowedValue, value));
const matchesPresentConstDiscriminators = (schema, value) => {
    const properties = isObject(schema.properties) ? schema.properties : {};
    return Object.entries(properties).every(([field, propertySchema]) => {
        if (!isObject(propertySchema) || !("const" in propertySchema) || !(field in value)) {
            return true;
        }
        return Object.is(propertySchema.const, value[field]);
    });
};
/** Validates the JSON Schema subset supported at RouteLedger's MCP boundary. */
export const validateValueAgainstSchema = (schema, value, path = []) => {
    const issues = [];
    const anyOf = schema.anyOf;
    if (Array.isArray(anyOf)) {
        const matchedSchema = anyOf.filter(isObject).some((candidate) => validateValueAgainstSchema(candidate, value, path).length === 0);
        if (!matchedSchema)
            issues.push({ path: formatPath(path), message: "Value does not match any allowed schema." });
        return issues;
    }
    const oneOf = schema.oneOf;
    if (Array.isArray(oneOf)) {
        const candidates = oneOf.filter(isObject);
        const candidateResults = candidates.map((candidate) => ({
            candidate,
            issues: validateValueAgainstSchema(candidate, value, path)
        }));
        const matchCount = candidateResults.filter((result) => result.issues.length === 0).length;
        if (matchCount !== 1) {
            const discriminatedResults = isObject(value)
                ? candidateResults.filter(({ candidate }) => matchesPresentConstDiscriminators(candidate, value))
                : [];
            if (matchCount === 0 && discriminatedResults.length === 1) {
                issues.push(...discriminatedResults[0].issues);
            }
            else {
                issues.push({ path: formatPath(path), message: `Value must match exactly one allowed schema; matched ${matchCount}.` });
            }
        }
        return issues;
    }
    const expectedType = schema.type;
    if (typeof expectedType === "string") {
        const actualType = Array.isArray(value) ? "array" : typeof value;
        switch (expectedType) {
            case "object":
                if (!isObject(value))
                    return [{ path: formatPath(path), message: `Expected object, received ${actualType}.` }];
                break;
            case "array":
                if (!Array.isArray(value))
                    return [{ path: formatPath(path), message: `Expected array, received ${actualType}.` }];
                break;
            case "string":
                if (typeof value !== "string")
                    return [{ path: formatPath(path), message: `Expected string, received ${actualType}.` }];
                break;
            case "integer":
                if (typeof value !== "number" || !Number.isInteger(value))
                    return [{ path: formatPath(path), message: `Expected integer, received ${actualType}.` }];
                break;
            case "boolean":
                if (typeof value !== "boolean")
                    return [{ path: formatPath(path), message: `Expected boolean, received ${actualType}.` }];
                break;
            case "null":
                if (value !== null)
                    return [{ path: formatPath(path), message: `Expected null, received ${actualType}.` }];
                break;
            default: return [{ path: formatPath(path), message: `Unsupported schema type '${expectedType}'.` }];
        }
    }
    if (Array.isArray(schema.enum) && !hasEnumMatch(schema.enum, value))
        issues.push({ path: formatPath(path), message: `Expected one of ${schema.enum.map(String).join(", ")}.` });
    if ("const" in schema && !Object.is(schema.const, value))
        issues.push({ path: formatPath(path), message: `Expected constant value ${String(schema.const)}.` });
    if (schema.type === "object" && isObject(value)) {
        const properties = isObject(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required) ? schema.required.filter((field) => typeof field === "string") : [];
        for (const field of required)
            if (!(field in value))
                issues.push({ path: formatPath(path.concat(field)), message: "Required field is missing." });
        if (schema.additionalProperties === false)
            for (const field of Object.keys(value))
                if (!(field in properties))
                    issues.push({ path: formatPath(path.concat(field)), message: `Additional property '${field}' is not allowed.` });
        for (const [field, propertySchema] of Object.entries(properties))
            if (field in value && isObject(propertySchema))
                issues.push(...validateValueAgainstSchema(propertySchema, value[field], path.concat(field)));
    }
    if (schema.type === "array" && Array.isArray(value) && isObject(schema.items))
        value.forEach((item, index) => issues.push(...validateValueAgainstSchema(schema.items, item, path.concat(index))));
    if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum)
        issues.push({ path: formatPath(path), message: `Expected ${describeExpectedType(schema)} greater than or equal to ${schema.minimum}.` });
    if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum)
        issues.push({ path: formatPath(path), message: `Expected ${describeExpectedType(schema)} less than or equal to ${schema.maximum}.` });
    return issues;
};
