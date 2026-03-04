const { config } = require("../config");

function calculatePrice({ pageCount, copies, colorMode }) {
  const unitPagePrice = colorMode === "color" ? config.pagePricing.colorPerPage : config.pagePricing.bwPerPage;
  const subTotal = pageCount * copies * unitPagePrice;
  const gstAmount = Number(((subTotal * config.gstPercent) / 100).toFixed(2));
  const total = Number((subTotal + gstAmount).toFixed(2));

  return {
    currency: "INR",
    unitPagePrice,
    subTotal,
    gstPercent: config.gstPercent,
    gstAmount,
    total,
  };
}

module.exports = { calculatePrice };
