/**
 * Custom resolve hook: redirect the `googleapis` package to ./fake-googleapis.js
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'googleapis') {
    return {
      shortCircuit: true,
      url: new URL('./fake-googleapis.js', import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}
