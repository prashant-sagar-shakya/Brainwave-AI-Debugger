import PropTypes from "prop-types";
import SectionSvg from "../assets/svg/SectionSvg";

const Section = ({
  className,
  id,
  crosses,
  crossesOffset,
  customPaddings,
  children,
}) => {
  const getPaddingClasses = () => {
    if (customPaddings) {
      return customPaddings;
    }

    let basePadding = "py-10 lg:py-16 xl:py-20";
    if (crosses) {
      basePadding += " lg:py-32 xl:py-40";
    }
    return basePadding;
  };

  const paddingClasses = getPaddingClasses();

  return (
    <div
      id={id || undefined}
      className={`
        relative
        ${paddingClasses}
        ${className || ""}
      `}
    >
      {children}

      <div className="hidden absolute top-0 left-5 w-0.25 h-full bg-stroke-1 pointer-events-none md:block lg:left-7.5 xl:left-10" />
      <div className="hidden absolute top-0 right-5 w-0.25 h-full bg-stroke-1 pointer-events-none md:block lg:right-7.5 xl:right-10" />

      {crosses && (
        <>
          <div
            className={`
              hidden absolute top-0 left-7.5 right-7.5 h-0.25 bg-stroke-1
              ${crossesOffset || ""}
              pointer-events-none lg:block xl:left-10 xl:right-10
            `}
          />
          <SectionSvg crossesOffset={crossesOffset} />
        </>
      )}
    </div>
  );
};

Section.propTypes = {
  className: PropTypes.string,
  id: PropTypes.string,
  crosses: PropTypes.bool,
  crossesOffset: PropTypes.string,
  customPaddings: PropTypes.string,
  children: PropTypes.node.isRequired,
};

Section.defaultProps = {
  className: "",
  id: undefined,
  crosses: false,
  crossesOffset: "",
  customPaddings: "",
};

export default Section;
