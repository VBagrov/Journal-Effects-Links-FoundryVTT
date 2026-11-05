export function randomId(length = 10) {
  return foundry.utils.randomID(length);
}

export function createSetId() {
  return `set_${randomId(10)}`;
}

export function createGrantId() {
  return `grant_${randomId(10)}`;
}

export function createObjectId() {
  return `obj_${randomId(10)}`;
}

export function createInstanceId() {
  return `instance_${randomId(10)}`;
}
