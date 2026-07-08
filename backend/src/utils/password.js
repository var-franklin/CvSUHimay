'use strict';

function checkPasswordPolicy(pw) {
  const errs = [];
  if (!pw || pw.length < 8)  errs.push('At least 8 characters');
  if (!/[A-Za-z]/.test(pw)) errs.push('At least one letter');
  if (!/\d/.test(pw))       errs.push('At least one digit');
  return errs;
}

module.exports = { checkPasswordPolicy };
