function isValidSouthAfricanId(idNumber) {
  if (!/^\d{13}$/.test(idNumber)) {
    return false;
  }

  const yearSuffix = Number(idNumber.slice(0, 2));
  const month = Number(idNumber.slice(2, 4));
  const day = Number(idNumber.slice(4, 6));
  const hasValidDate = [1900 + yearSuffix, 2000 + yearSuffix].some((year) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  });

  if (!hasValidDate) {
    return false;
  }

  const digits = [...idNumber].map(Number);
  const oddPositionSum = digits
    .slice(0, 12)
    .filter((_, index) => index % 2 === 0)
    .reduce((sum, digit) => sum + digit, 0);
  const doubledEvenPositionSum = String(
    Number(digits.slice(0, 12).filter((_, index) => index % 2 === 1).join('')) * 2
  )
    .split('')
    .reduce((sum, digit) => sum + Number(digit), 0);

  return (oddPositionSum + doubledEvenPositionSum + digits[12]) % 10 === 0;
}

module.exports = { isValidSouthAfricanId };
