import PlusSvg from "./PlusSvg";

const SectionSvg = () => {
  return (
    <>
      <PlusSvg
        className={`hidden absolute -top-[0.3125rem] left-[1.5625rem] pointer-events-none lg:block xl:left-[2.1875rem]`}
      />

      <PlusSvg
        className={`hidden absolute  -top-[0.3125rem] right-[1.5625rem] pointer-events-none lg:block xl:right-[2.1875rem]`}
      />
    </>
  );
};

export default SectionSvg;
